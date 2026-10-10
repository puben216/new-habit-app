# ADR-012: 管理者のアクセス方式

Status: accepted
Date: 2026-10-10

Context:
T-403 で、サポート・運用担当が最小限の個人情報でアカウント状態・通知失敗・AI ジョブ失敗を read-only に確認できるようにする。制約は次のとおり。

- [ADR-001](ADR-001-authentication.md): 認証は Auth.js(Credentials、DB session 行を JWT が指す)。Admin の MFA(TOTP)は T-403 で実装する。
- [docs/08](../08-security.md): Admin は別 role、MFA 必須、通常 UI/API と route/permission を分離。admin action は append-only の監査。
- [AGENTS.md](../../AGENTS.md): 認証と認可は別の関心事。個人情報の収集・参照は最小限。email・token・自由記述をログに出さない。

Decision:

- **管理者の表現**: `users` とは別の `admin_users` 表(`user_id` UNIQUE、`public_id`、`status`)。通常ユーザーの表に権限を混ぜず、SQL やアプリの不具合による昇格の経路を減らす。付与・無効化・MFA の再発行は **運用スクリプトのみ**(`pnpm admin:grant|admin:disable|admin:reset-mfa`)。API/UI に経路を作らない。
- **認可**: 管理者かどうかは **毎回 DB(`admin_users`)で判定** し、session・JWT・クライアントに持たせない(無効化が次のリクエストから効く)。管理者でないユーザーには管理 route を `404`(存在しない route と同じ応答)で秘匿し、入力形式の検証結果も明かさない。未認証は `401`、管理者で MFA 未検証/期限切れは `403`(`mfa_required`)。
- **MFA**: 通常どおり email+password でログインした後、管理 API を使うために TOTP(RFC 6238、HMAC-SHA1・30 秒・6 桁、±1 ステップ)またはリカバリーコード(8 個、単回使用、SHA-256 のハッシュのみ保存)を検証する。検証時刻は **session 行**(`sessions.mfa_verified_at`)に持ち、検証から 30 分の絶対期限。新しいログイン・logout・失効・`admin:disable`・`admin:reset-mfa` で無効になる。直前に受理したステップ以下は拒否し(replay 防止)、連続 5 回の失敗で 15 分ロックする(ロック中はコードの正否を調べない)。
- **秘密の保存**: TOTP の秘密は AES-256-GCM で暗号化して保存する(鍵は環境変数 `ADMIN_TOTP_ENCRYPTION_KEY`、AAD は所有ユーザーの ID)。平文はスクリプトの標準出力に一度だけ表示する。
- **最小露出**: 検索は email の **完全一致** のみ(部分一致・列挙なし)、表示は公開 ID・状態・作成日時とマスクした email(`u***@example.test`)。概要は状態別の件数のみ。習慣・記録・メモ・通知設定の中身、AI の入出力は一切読まない。応答は allowlist のスキーマで返す。
- **監査**: すべての閲覧・MFA の検証・スクリプトの操作を `audit_logs` に **閲覧の前に** 追記し、追記に失敗したら閲覧しない(fail closed)。actor は `admin:{公開 ID}` または `operator`、IP は鍵つき HMAC のみ。検索した email・コード・秘密は残さない。`audit_logs` は DB の trigger で UPDATE/DELETE/TRUNCATE を拒否する(多層防御。実際の境界は runtime role の権限で、共通基盤 T-501/T-502 で設定する)。
- **read-only**: 管理 API は `GET` と `POST /admin/mfa/verify` のみ。書き込み操作(アカウント停止、配送の再送など)は別 Spec で、監査・承認の設計とともに扱う。

Alternatives considered:

- `users.role` 列で表現する: 表は増えないが、通常ユーザーの表に権限が混ざり、昇格の影響が大きい。付与経路を運用スクリプトに限るほうが、権限昇格の面を小さくできる。
- 管理者専用の別 session・別ログイン画面: 分離は強いが、Auth.js の拡張・別の session 管理・別画面が増え、T-403 の範囲が大きくなる。既存 session への MFA の追加認証と、毎回の DB 判定・404 秘匿で、同等の要件(分離・MFA・即時無効化)を満たす。
- ライブラリ(otplib 等)で TOTP を実装する: 依存が増える。RFC 6238 は小さく、公式のテストベクトルで検証できるため、`node:crypto` で実装した。
- Cognito 等の IdP の MFA: ADR-001 で見送り済み。
- 閲覧後に監査を書く: 監査が失敗した場合に、記録のない閲覧が起こりうる。fail closed のため、閲覧の前に追記する。
- 管理者向けの検索を部分一致にする: サポートは楽になるが、管理者による個人情報の大量閲覧・列挙が可能になり、内部不正の脅威(docs/08)が増える。

Consequences:

- 監査の追記が失敗すると閲覧ができなくなる(可用性より追跡可能性を優先)。DB 障害時は管理 API も止まる。
- MFA の検証は session 単位のため、別の端末・新しいログインでは都度 MFA が必要。30 分ごとに再検証が必要。
- 管理者の付与には DB と暗号鍵に到達できる担当者が必要。鍵(`ADMIN_TOTP_ENCRYPTION_KEY`、`AUDIT_IP_HASH_KEY`)の管理は Secrets Manager(共通基盤 T-501)で行い、ローテーションは版数 `v1` を使って後続で対応する。
- 監査ログの保持期間・ユーザー削除時の匿名化は T-404 で設計する(追記専用 trigger を保守する専用の Migration が必要)。
- AI ジョブの一覧は T-303 まで常に空。
- Rate limit は未実装。MFA は専用のロックアウトで、検索・一覧は完全一致・上限・監査で抑える。

Security/operational impact:

- 管理者の漏えい・乗っ取りの影響を、最小露出(マスク・概要のみ)と全閲覧の監査で限定する。レビューは Runbook([docs/runbooks/admin-operations.md](../runbooks/admin-operations.md))の手順で行う。
- ログに email・コード・秘密・session token・IP の生値を出さない。

Review date: 管理者の書き込み操作を追加する前、rate limit の導入時、または T-505(限定 beta)判断時。
