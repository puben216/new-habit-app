# 最小管理機能 Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-09
変更区分: Standard
ロードマップ項目: T-403

## 目的

サポート・運用担当(Admin)が、ユーザーのアカウント状態、通知配送の失敗、AI ジョブの失敗を、最小限の個人情報で read-only に確認できるようにする(UC-16、PRD 機能要件 11)。管理機能は通常ユーザーの UI/API から権限と route を分離し、多要素認証(TOTP)を必須とし、すべての閲覧を追記専用の監査ログに残す([ADR-001](../adr/ADR-001-authentication.md)、[docs/08](../08-security.md))。

## 成功指標

- Admin ではないユーザー(未登録の Member、admin が無効化された元 Admin を含む)は、どの `/api/v1/admin/*` でも「存在しない」(404)として扱われ、route の有無や入力形式の検証結果から管理機能の構成を推測できない(Unit/Integration Test)。
- Admin であっても、TOTP を検証していない、または検証から 30 分を過ぎた session では、`mfa_required`(403)で閲覧できない。
- 管理画面・API の閲覧(検索、詳細、一覧)は、成功したものが必ず 1 件以上の監査ログを残し、監査ログの書き込みに失敗した場合は閲覧自体を行わない(fail closed。Integration Test)。
- 監査ログは UPDATE/DELETE/TRUNCATE を DB が拒否する(Integration Test)。
- TOTP の同じコードの再利用(replay)、連続失敗による総当たりを拒否する。
- 管理 API の応答・監査ログ・ログに、email(マスク表示を除く)、習慣名、メモ、通知設定の中身、AI の入出力、TOTP の秘密・コードが含まれない。

## 範囲

PR-A(バックエンド)と PR-B(画面と E2E)の 2 本に分けて届ける。

- Domain(admin): email のマスク、MFA の有効期限・ロックアウトの判定と定数、MFA コードの正規化(TOTP/リカバリーコード)、監査 action の型。
- Application: Admin の認可(`authorizeAdmin`)、MFA 検証(`verifyAdminMfaUseCase`)、閲覧 use case(ユーザー検索、ユーザー概要、通知失敗一覧、AI ジョブ失敗一覧)と各 port、Admin の付与・無効化・MFA 再発行(運用スクリプトが呼ぶ use case)。
- Infrastructure: Prisma repository 群、TOTP(RFC 6238)、secret の暗号化(AES-256-GCM)、リカバリーコードのハッシュ、IP の不可逆化(HMAC)、監査ログの追記。
- DB: Migration 1 本(`admin_users`、`admin_recovery_codes`、`sessions.mfa_verified_at`、`audit_logs` の追記専用化と index)。
- Presentation(`apps/web`、PR-A): `POST /api/v1/admin/mfa/verify`、`GET /api/v1/admin/me`、`GET /api/v1/admin/users`、`GET /api/v1/admin/users/{publicId}`、`GET /api/v1/admin/operations/notifications`、`GET /api/v1/admin/operations/ai-jobs`。
- 運用スクリプト(PR-A): `pnpm admin:grant|disable|reset-mfa`(Admin の付与・無効化・MFA 再発行)。
- 画面と E2E(PR-B): `/admin/mfa`、`/admin`、`/admin/users`、`/admin/users/[publicId]`、`/admin/notifications`、`/admin/ai-jobs`、Playwright E2E。
- 文書: `docs/04`、`docs/05`、`docs/08`、`docs/09`、`docs/10`、新しい ADR(ADR-012)、Runbook。

## 対象外

- Admin による書き込み操作(アカウント停止、設定変更、配送の再送、suppression 解除など)。本タスクは read-only。
- email の部分一致検索、ユーザー一覧の列挙、CSV 等のエクスポート。
- 習慣・記録・チェックイン・週次レビュー・通知設定の中身、AI の入出力(prompt、結果本文)の閲覧。
- Admin 内の細かい role 分離(support/operator 等)。本タスクは単一の `admin`。
- 再認証を要する sensitive action(閲覧のみのため)。Admin の password 変更・email 変更。
- Rate limit(P2 未決。受容リスク)、WebAuthn/パスキー、SMS の MFA。
- 監査ログの保持期間・ユーザー削除時の匿名化(T-404)。監査ログの閲覧 UI。
- 本番の DB role 分離(runtime role に `audit_logs` の INSERT/SELECT のみを付与する設定は共通基盤 T-501/T-502)。

## アクターと前提条件

| アクター            | 前提条件                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| Guest(未認証)       | なし。すべての `/api/v1/admin/*` で `401`                                                                 |
| Member              | 通常の session。`admin_users` に有効な行がない。すべての `/api/v1/admin/*` で `404`                       |
| Admin(MFA 未検証)   | 通常の session(email+password)と有効な `admin_users` 行。`/admin/mfa/verify` と `/admin/me` のみ使える    |
| Admin(MFA 検証済み) | 同 session で TOTP またはリカバリーコードを検証してから 30 分以内。read-only の閲覧 API を使える          |
| 運用担当            | DB と `ADMIN_TOTP_ENCRYPTION_KEY` に到達できる環境でスクリプトを実行する(Web/API からは Admin を作れない) |

Admin は、通常どおり登録・email 確認済みの Member に `admin_users` 行を付与して作る。actor の user ID は session のみから取得する。

## 機能要件

### ADM-001 Admin の付与・無効化・MFA 再発行(運用)

- `pnpm admin:grant --email <email>` は、email 確認済みで `active` の既存ユーザーに `admin_users` 行を作る。TOTP の秘密(20 バイトの乱数)を生成して暗号化して保存し、otpauth URI と 8 個のリカバリーコードを標準出力に **一度だけ** 表示する(ハッシュのみ保存)。既に Admin なら何も変えずに失敗を返す。
- `pnpm admin:disable --email <email>` は `status = 'disabled'` にする(以後 `404` 扱い)。`pnpm admin:reset-mfa --email <email>` は TOTP の秘密とリカバリーコードを作り直し、そのユーザーの全 session の MFA 検証を無効にする。
- スクリプトの実行は監査ログに残す(actor は `operator`)。スクリプトは対象ユーザーの email を出力・ログに含めない(入力として受け取るだけ)。

### ADM-002 Admin の認可

- すべての `/api/v1/admin/*` は、session から actor user ID を得て(未認証は `401`)、`admin_users` で有効な Admin か確認する。有効な Admin でなければ **`404`**(`code: not_found`)を返す(管理 route の存在を明かさない)。
- 有効な Admin でも、session の `mfa_verified_at` が 30 分以内でなければ **`403`**(`code: mfa_required`)。`POST /admin/mfa/verify` と `GET /admin/me` だけは MFA 未検証でも使える。
- 認可は呼び出しごとに DB で判定する(session や client に Admin かどうかを持たせない)。Admin の無効化は次のリクエストから有効になる。

### ADM-003 MFA の検証

- `POST /api/v1/admin/mfa/verify` は body `{ code }` を受け取る。`code` は 6 桁の TOTP、または `XXXXX-XXXXX` 形式のリカバリーコード(大文字小文字・前後の空白・空白を無視)。
- 検証に成功したら、その **session 行** の `mfa_verified_at` を現在時刻にして `200`。新しいログイン(新しい session)は MFA 未検証から始まる。ログアウトまたは session 失効で検証も消える。
- TOTP は RFC 6238(HMAC-SHA1、30 秒、6 桁)で、前後 1 ステップ(±30 秒)を許容する。直前に受理したステップ以下のコードは受理しない(replay 防止)。リカバリーコードは未使用のものを一度だけ受理し、使ったら `used_at` を記録する。
- 失敗は **`403`**(`code: invalid_mfa_code`)で、TOTP とリカバリーコードのどちらが誤りかを区別しない。連続 5 回失敗した Admin は 15 分ロックし、ロック中は **`429`**(`code: mfa_locked`、`Retry-After`)を返し、コードの正否を調べない。成功で失敗回数を 0 に戻す。
- 成功・失敗・ロックはすべて監査ログに残す。コード自体は記録しない。

### ADM-004 ユーザー検索

- `GET /api/v1/admin/users?email=<email>` は、email の **完全一致**(正規化後: trim + 小文字)で 0 件または 1 件を返す。部分一致・前方一致・一覧の列挙はできない。
- 結果の項目は `publicId`、`emailMasked`、`status`、`createdAt` のみ。見つからない場合は `200` で `items: []`(404 にしない。存在確認の挙動を admin API 内で一定にする)。
- 検索で使った email は監査ログに残さない(検索したという事実 `admin.user.search` のみ)。

### ADM-005 ユーザー概要

- `GET /api/v1/admin/users/{publicId}` は、そのユーザーの概要を返す: `publicId`、`emailMasked`、`status`、`createdAt`、`emailVerified`(真偽値)、`notification`(`enabled`、`suppressed`、直近 30 日の配送の状態別件数)、`aiJobs`(直近 30 日の状態別件数)。ユーザーがいなければ `404`(`user_not_found`)。
- 習慣・記録・メモ・通知設定の時刻や timezone、AI の入出力、email の全体は返さない。
- 閲覧は監査ログに `admin.user.view`(対象は `publicId`)として残す。

### ADM-006 通知配送の失敗一覧

- `GET /api/v1/admin/operations/notifications` は、配送の状態が `failed`/`expired`/`suppressed` のものを新しい順に返す。query: `status`(上記のいずれか、省略で 3 つ)、`limit`(1〜50、既定 20)、`cursor`。項目は `id`、`userPublicId`、`status`、`failureCode`、`attemptCount`、`scheduledAt`、`localDate`、`updatedAt` のみ。email、設定の中身、provider の応答は含まない。
- 閲覧は `admin.notifications.list` として監査ログに残す。

### ADM-007 AI ジョブの失敗一覧

- `GET /api/v1/admin/operations/ai-jobs` は、状態が `failed`/`fallback` のジョブを新しい順に返す。query は ADM-006 と同様(`status` は `failed`/`fallback`)。項目は `publicId`、`userPublicId`、`kind`、`status`、`failureCode`、`provider`、`model`、`promptVersion`、`createdAt` のみ。`result_json`、入力の指紋、prompt、自由記述は含まない。
- AI の非同期パイプライン(T-303)は未実装のため、現時点ではデータが無く空の一覧を返す。閲覧は `admin.ai_jobs.list` として監査ログに残す。

### ADM-008 自分の状態

- `GET /api/v1/admin/me` は、有効な Admin に `{ adminPublicId, mfaVerified, mfaExpiresAt }` を返す(画面が MFA 画面へ誘導するため)。Admin でなければ `404`。

## 業務ルールと不変条件

- ADM-INV-001(Admin の判定): Admin は `admin_users` の `status = 'active'` の行がある users のみ。判定は毎回 DB で行い、session・cookie・JWT・クライアントの状態に持たせない。
- ADM-INV-002(存在の秘匿): Admin でないユーザーには、すべての管理 route が `404` で、応答の差(本文・ヘッダー・処理時間の大きな差)がない。未認証だけが `401`。
- ADM-INV-003(MFA の有効期限): `mfa_verified_at` から 30 分未満、かつ未来時刻でないときだけ有効(定数 `ADMIN_MFA_TTL_MS` 1 箇所)。有効期限は絶対(アクセスで延長しない)。
- ADM-INV-004(監査は fail closed): 閲覧系の use case は、**閲覧の前に** 監査ログを追記し、追記に失敗したら閲覧を行わず失敗させる。監査ログに記録するのは actor(`admin:{adminPublicId}`)、action、対象の種別と公開 ID、request ID、IP の不可逆化表現(HMAC-SHA256)のみ。
- ADM-INV-005(追記専用): `audit_logs` は UPDATE/DELETE/TRUNCATE を DB の trigger が拒否する(多層防御。本番の実際の境界は runtime role の権限で、共通基盤 T-501/T-502 で設定する)。
- ADM-INV-006(最小露出): 管理 API が返す個人情報は `emailMasked`(先頭 1 文字 + `***` + `@` + ドメイン。ローカル部が 1 文字なら `***`)と公開 ID のみ。内部 ID(bigint)は、配送の `id`(運用上の参照用)を除き返さない。
- ADM-INV-007(秘密の保護): TOTP の秘密は `ADMIN_TOTP_ENCRYPTION_KEY` による AES-256-GCM で暗号化して保存し(所有ユーザーの ID を認証付き追加データに含める。行を作る前に確定している識別子のため)、リカバリーコードは SHA-256 のハッシュのみ保存する。平文はスクリプトの標準出力に一度だけ出し、DB・ログ・監査ログに残さない。
- ADM-INV-008(read-only): 管理 API は `GET`(閲覧)と `POST /admin/mfa/verify` のみ。ユーザーのデータを変更する管理 API を作らない。
- ADM-INV-009(定数): MFA の有効期限 30 分、失敗上限 5 回、ロック 15 分、リカバリーコード 8 個、ページサイズ上限 50 は Domain の定数 1 箇所のみで定義する(暫定値)。

## 状態遷移

| 対象           | 現在            | イベント                             | 次                  | 備考                                 |
| -------------- | --------------- | ------------------------------------ | ------------------- | ------------------------------------ |
| admin_users    | (なし)          | `admin:grant`                        | active              | TOTP 秘密・リカバリーコードを生成    |
| admin_users    | active          | `admin:disable`                      | disabled            | 以後 404。session の MFA 検証も無効  |
| admin_users    | disabled        | `admin:grant`                        | active              | MFA を作り直す(秘密・コードを再生成) |
| session の MFA | 未検証/期限切れ | `mfa/verify` 成功                    | 検証済み(30 分)     | 新しい session は未検証              |
| session の MFA | 検証済み        | 30 分経過、logout、`admin:reset-mfa` | 未検証              |                                      |
| 失敗カウント   | 0〜4            | 失敗                                 | +1                  | 5 回目でロック(15 分)                |
| 失敗カウント   | ロック中        | 15 分経過後の次の検証                | 1(失敗時)/0(成功時) | ロック中はコードを調べない           |
| recovery code  | 未使用          | 検証成功                             | 使用済み            | 再利用不可                           |

## 受け入れ基準

```gherkin
シナリオ: Member は管理 route を知ることができない
  前提 通常の Member(admin_users なし)でログイン済み
  もし GET /api/v1/admin/users?email=a@example.test を呼ぶ
  ならば 404 not_found(存在しない route と同じ応答。管理 route の存在を明かさない)
  かつ 未認証なら 401

シナリオ: MFA 未検証の Admin
  前提 有効な Admin でログイン済み、MFA は未検証
  もし GET /api/v1/admin/users?email=... を呼ぶ
  ならば 403 mfa_required
  かつ GET /api/v1/admin/me は 200 で mfaVerified=false

シナリオ: TOTP で MFA を検証する
  もし 正しい 6 桁の TOTP を POST /api/v1/admin/mfa/verify に送る
  ならば 200 で、その session の mfa_verified_at が更新される
  かつ 30 分以内は閲覧できる
  かつ 29 分では閲覧でき、30 分では mfa_required に戻る

シナリオ: TOTP の再利用と総当たりを拒否する
  前提 直前に受理した TOTP コード
  もし 同じコードを再度送る
  ならば 403 invalid_mfa_code
  かつ 誤ったコードを 5 回送ると 429 mfa_locked になり、15 分後まで正しいコードも拒否される
  かつ ロック明けの正しいコードは受理され、失敗回数は 0 に戻る

シナリオ: リカバリーコード
  もし 未使用のリカバリーコード(小文字・ハイフン前後に空白あり)を送る
  ならば 200 で、そのコードは使用済みになり、再度送ると 403 invalid_mfa_code

シナリオ: ユーザー検索は完全一致のみ
  前提 MFA 検証済みの Admin、ユーザー user@example.test が存在
  もし email=USER@Example.test を検索する
  ならば items が 1 件で emailMasked は "u***@example.test"、publicId・status・createdAt を含む
  かつ email=user や email=@example.test では items=[]
  かつ 応答に習慣名・メモ・通知設定の中身が含まれない

シナリオ: ユーザー概要
  前提 通知の配送が failed 1 件、sent 3 件のユーザー
  もし GET /api/v1/admin/users/{publicId}
  ならば notification.deliveries が {failed:1, sent:3}、suppressed の真偽、aiJobs の件数を返す
  かつ 存在しない公開 ID は 404 user_not_found

シナリオ: 失敗一覧
  もし GET /api/v1/admin/operations/notifications?status=failed&limit=2 を呼ぶ
  ならば 新しい順で最大 2 件と nextCursor を返し、email や設定の中身を含まない
  かつ limit=51 や不正な status は 422

シナリオ: 監査
  もし Admin が検索・概要・一覧を閲覧する
  ならば 閲覧ごとに audit_logs が追記され、actor は admin:{adminPublicId}、検索した email は残らない
  かつ 監査ログの追記が失敗した場合は閲覧が行われず 500 になる
  かつ audit_logs に UPDATE/DELETE/TRUNCATE をすると DB が拒否する

シナリオ: 無効化
  前提 MFA 検証済みの Admin
  もし admin:disable を実行する
  ならば 次のリクエストから 404 になる

シナリオ: 別 session は MFA を引き継がない
  前提 session A で MFA 検証済み
  もし 同じ Admin が新しく login した session B で管理 API を呼ぶ
  ならば 403 mfa_required
```

## 認可マトリクス

| 操作                                          | Guest | Member | Admin(MFA 未検証) | Admin(MFA 検証済み) | 所有権ルール                             |
| --------------------------------------------- | ----: | -----: | ----------------: | ------------------: | ---------------------------------------- |
| POST /admin/mfa/verify                        |   401 |    404 |               Yes |                 Yes | 自分の session のみ                      |
| GET /admin/me                                 |   401 |    404 |               Yes |                 Yes | 自分のみ                                 |
| GET /admin/users(検索)                        |   401 |    404 |               403 |                 Yes | 任意のユーザー(完全一致 + マスク + 監査) |
| GET /admin/users/{publicId}                   |   401 |    404 |               403 |                 Yes | 任意のユーザー(概要のみ + 監査)          |
| GET /admin/operations/notifications           |   401 |    404 |               403 |                 Yes | 全ユーザーの失敗(email なし + 監査)      |
| GET /admin/operations/ai-jobs                 |   401 |    404 |               403 |                 Yes | 全ユーザーの失敗(入出力なし + 監査)      |
| admin:grant / disable / reset-mfa(スクリプト) |     — |      — |                 — |                   — | 運用担当が DB と鍵に到達できる場合のみ   |

## APIとイベント

共通: base path `/api/v1/admin`、JSON、未知キー拒否、Problem Details、`Cache-Control: no-store`、`X-Robots-Tag: noindex`。`POST` は `Content-Type: application/json` 必須(`415`)、body 上限 1 KiB(`413`)、Origin 検証(`403 invalid_origin`)。Events は発行しない。契約の正本は `packages/contracts/src/admin.ts` の runtime schema と本 Spec(OpenAPI 生成基盤は未導入)。

| Method/Path                           | 入力                                  | 成功 | エラー                                                                          |
| ------------------------------------- | ------------------------------------- | ---- | ------------------------------------------------------------------------------- |
| `POST /admin/mfa/verify`              | body: `code`                          | 200  | 401, 403(invalid_mfa_code, invalid_origin), 404, 413, 415, 422, 429(mfa_locked) |
| `GET /admin/me`                       | なし                                  | 200  | 401, 404                                                                        |
| `GET /admin/users`                    | query: `email`                        | 200  | 401, 403(mfa_required), 404, 422                                                |
| `GET /admin/users/{publicId}`         | path                                  | 200  | 401, 403, 404(not_found, user_not_found), 422                                   |
| `GET /admin/operations/notifications` | query: `status?`, `limit?`, `cursor?` | 200  | 401, 403, 404, 422                                                              |
| `GET /admin/operations/ai-jobs`       | query: `status?`, `limit?`, `cursor?` | 200  | 401, 403, 404, 422                                                              |

### 応答の例

```json
{
  "items": [
    {
      "publicId": "…",
      "emailMasked": "u***@example.test",
      "status": "active",
      "createdAt": "2026-10-01T00:00:00.000Z"
    }
  ]
}
```

```json
{
  "items": [
    {
      "id": "42",
      "userPublicId": "…",
      "status": "failed",
      "failureCode": "rejected",
      "attemptCount": 1,
      "scheduledAt": "…",
      "localDate": "2026-10-09",
      "updatedAt": "…"
    }
  ],
  "nextCursor": null
}
```

- 422 の `code` は `validation_failed`(`fieldErrors`)。`email` は email 形式で 254 文字以内、`cursor` は十進文字列。
- cursor は直前ページの最後の項目の ID(`id` の降順 keyset)のみを持つ。ユーザーや権限の情報を含めない。

## データとMigration

Migration `t403_minimal_admin`(expand のみ。既存行への影響なし):

- `admin_users`: `id bigserial`、`public_id uuid` UNIQUE 既定 `gen_random_uuid()`、`user_id bigint` UNIQUE(FK `users` `ON DELETE CASCADE`)、`status text` CHECK(`active`/`disabled`)既定 `active`、`totp_secret_enc text NOT NULL`、`totp_last_step bigint`、`mfa_failed_attempts int NOT NULL DEFAULT 0` CHECK(`>= 0`)、`mfa_locked_until timestamptz`、`created_at`、`updated_at`(`set_updated_at` trigger)。FK `user_id` の index は UNIQUE が兼ねる。
- `admin_recovery_codes`: `id bigserial`、`admin_user_id bigint NOT NULL`(FK `admin_users` `ON DELETE CASCADE`、index あり)、`code_hash text NOT NULL` UNIQUE、`used_at timestamptz`、`created_at`。
- `sessions.mfa_verified_at timestamptz`(NULL 許容。既存 session は未検証)。
- `audit_logs`: UPDATE/DELETE の `BEFORE` trigger と TRUNCATE の `BEFORE` statement trigger で例外を投げる(追記専用)。`(actor, created_at DESC)` と `(created_at DESC, id DESC)` の index、`actor`/`action` の空文字を拒否する CHECK。既存行なし。
- アクセスパターン: Admin の判定 `WHERE user_id = ?`(UNIQUE)、検索 `WHERE email_normalized = ?`(既存 UNIQUE)、概要の集計 `WHERE user_id = ? AND created_at >= ?`(`notification_deliveries` は既存 `(user_id)` index、`ai_jobs` は既存 `(user_id)` index)、失敗一覧 `WHERE status IN (…) ORDER BY id DESC`(件数が増えたら部分 index を T-501 以降で検討。受容リスク)。
- 時刻は `timestamptz`(UTC)。`totp_last_step` は UNIX 時刻 / 30 の整数。
- 保持: `admin_users` はユーザー削除(T-404)で CASCADE。監査ログは追記専用で保持期間と匿名化は T-404 で設計する(`audit_logs` は users への FK を持たないため、ユーザー削除では消えない)。
- 検証: fresh database と、直前の Migration までの既存 schema(既存の session 行・audit_logs 行があっても)からの upgrade の両方を Integration Test で確認する。
- ロールバック: expand のみ。アプリを revert すれば足り、必要なら forward Migration で trigger/テーブルを DROP する(適用済み Migration は編集しない)。

## 失敗・境界ケース

- `email` が空・形式不正・254 文字超 → 422。大文字小文字・前後の空白は正規化(`USER@Example.test` → 一致)。
- MFA コードの形式不正(長さ・文字種)→ 422 ではなく **`403 invalid_mfa_code`**(形式を oracle にしない)。ただし body が JSON でない、`code` が文字列でないは 422。
- TOTP の時刻ずれ: ±1 ステップを許容。それ以外は失敗。サーバー時刻は注入された Clock。
- 同じ Admin の並行検証: 失敗カウント・replay 防止・リカバリーコードの使用は単一の条件付き `UPDATE` で行い、同じコードの並行送信で複数が成功しない。
- ロック中の検証: コードの正否を調べず `429`。ロックの残り時間は `Retry-After`(秒)で返す。
- Admin 自身の user が停止・削除された場合: 削除は CASCADE で `admin_users` ごと消える。停止(`users.status` が `active` でない)は Admin として扱わない(404)。
- session が失効・ログアウト済み: 通常の認証で `401`。
- 監査ログの追記失敗(DB 障害): 閲覧を行わず 500(内部詳細は返さない)。
- `audit_logs` の request ID: `x-request-id` があれば使い(英数と `-` の 64 文字以内)、なければ UUID を生成する。IP は信頼できる最初の転送元(ALB 背後)を HMAC し、取得できなければ固定値 `unknown` を HMAC する。
- ページング: `cursor` が不正 → 422。範囲外 `limit` → 422。空の結果 → `items: []`、`nextCursor: null`。
- DB 制約違反(Domain/契約をすり抜けた場合)→ 500。内部詳細は含めない。

## セキュリティとプライバシー

- 収集データ: Admin の TOTP 秘密(暗号化)、リカバリーコードのハッシュ、失敗回数・ロック時刻、MFA 検証時刻、監査ログ(actor、action、対象の公開 ID、request ID、IP のハッシュ)。
- 外部送信データ: なし(外部 provider に送らない)。
- ログ禁止データ: email、TOTP コード・秘密・リカバリーコード、session token、cookie、request body、検索 query、IP の生値、鍵。ログには action 名と件数・状態のみ。例外メッセージに秘密・email を含めない。
- 脅威と対策:
  - 権限昇格: Admin の付与は運用スクリプトのみ(API/UI に経路なし)。判定は毎回 DB。管理 route は通常 route と別 path とし、Member には `404`。
  - MFA の総当たり・replay: 失敗 5 回で 15 分ロック、直前ステップ以下の拒否、リカバリーコードは単回使用・高エントロピー(50 ビット)。比較は定数時間。
  - session の乗っ取り: MFA 検証は session 単位で 30 分の絶対期限。新しい login、logout、`admin:reset-mfa` で無効になる。通常の session cookie(HttpOnly/Secure)の保護は T-101。
  - CSRF: 状態を変える `POST /admin/mfa/verify` は Origin 検証 + `Content-Type: application/json`。他は `GET`(副作用は監査の追記のみ)。
  - 内部不正・大量閲覧: 完全一致のみ、マスク、概要のみ、全閲覧の監査。監査ログは追記専用で、Admin 自身は書き換えられない。レビューは Runbook に手順を置く。
  - IDOR/BOLA: 管理 API は意図して任意のユーザーを参照できるため、アクセス制御は Admin の認可(ADM-002)と最小露出(ADM-INV-006)・監査で担保する。
  - 鍵の管理: `ADMIN_TOTP_ENCRYPTION_KEY` と `AUDIT_IP_HASH_KEY` は Secrets Manager の器から ECS に渡す(値は state に入れない。T-501)。鍵のローテーションは `v1` の版数で後続対応(未決事項)。
  - 情報漏えい: 応答は最小項目の allowlist(スキーマで列挙)。email はマスク。
- 個人情報の影響: 管理者による個人データの参照は、処理として監査される。T-404 のエクスポート/削除の対象に `admin_users` を含める(CASCADE)。

## AI要件

N/A。AI を利用しない。AI ジョブは状態・失敗コード・メタデータのみを読み取り、入出力本文には触れない。

## 可観測性と運用

- ログ: route に独自ログを追加しない(構造化ログ基盤が未導入)。監査ログが運用上の記録の正本。スクリプトは結果(成功/失敗、admin の公開 ID)のみを出力する。
- メトリクス/アラート: 既存方針(`docs/06`)の request count/error/latency に含まれる。MFA の失敗・ロック、`mfa_locked` の増加、管理 API の 5xx を後続(T-501 の observability)でアラート化する。専用 metric は追加しない。
- Runbook: `docs/runbooks/admin-operations.md`(Admin の付与・無効化・MFA 再発行、監査ログのレビュー、鍵のローテーション、漏えい疑い時の対応)を作成する。
- 展開/ロールバック: Feature Flag は不要(Admin が作られるまで管理 API は常に `404`/`401`)。Migration は expand のみ。ロールバックはアプリの revert。Admin を作る前は影響がない。
- 費用/capacity: 影響なし。

## テスト対応表

| 要件        | Unit                                                                                                                        | Integration(実 PostgreSQL)                                                                               | E2E                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| ADM-001     | `grantAdminUseCase` 等(対象の検証、既存 Admin、コードの一度きり表示)、TOTP 秘密・リカバリーコード生成のプロパティ           | `admin_users` 作成・無効化・MFA 再発行・session の MFA 失効、スクリプトの監査                            | N/A                                           |
| ADM-002     | `authorizeAdmin`(not_admin/disabled/mfa_required/granted、境界 29/30 分、未来時刻)、handler の 401/404/403 と応答の同一性   | `admin_users` の判定、停止ユーザー、無効化後の即時反映                                                   | PR-B: member 拒否、admin 未 MFA、admin access |
| ADM-003     | `verifyAdminMfaUseCase`(成功/失敗/ロック/replay/リカバリー)、TOTP(RFC 6238 ベクトル、±1 ステップ、プロパティ)、コード正規化 | 失敗カウントの原子性、並行 6 件で 1 回だけ成功、ロック解除、リカバリーコードの単回使用、session 行の更新 | PR-B: TOTP 検証→閲覧                          |
| ADM-004     | email 正規化・マスク(プロパティ: マスクから local 部が復元できない)、完全一致のみ                                           | 検索(大文字小文字、部分一致で 0 件)、応答に余計な列がない                                                | PR-B: 検索                                    |
| ADM-005     | 概要の組み立て、存在しない公開 ID                                                                                           | 状態別件数の集計、suppressed、他ユーザーの混入なし                                                       | PR-B: 概要                                    |
| ADM-006/007 | 一覧の項目 allowlist、limit/cursor/status の検証                                                                            | keyset ページング、status フィルタ、email・結果本文を含まない                                            | PR-B: 失敗一覧                                |
| ADM-INV-004 | 閲覧前に監査、監査失敗で閲覧しない                                                                                          | 各閲覧で監査行、actor/対象、検索 email が残らない                                                        | PR-B: 監査行                                  |
| ADM-INV-005 | -                                                                                                                           | UPDATE/DELETE/TRUNCATE が拒否される                                                                      | N/A                                           |
| ADM-INV-007 | 暗号化の往復、改ざん・別 admin の AAD で復号失敗                                                                            | DB に平文の秘密・コードが無い                                                                            | N/A                                           |
| DB 制約     | -                                                                                                                           | CHECK(status)、UNIQUE、CASCADE、fresh と upgrade の Migration                                            | N/A                                           |

Fake/Stub 方針: Application の unit test は in-memory fake と固定 Clock・乱数。TOTP は RFC 6238 の公開テストベクトルで検証。Integration は Testcontainers の実 PostgreSQL。fixture は架空データ(`example.test`)のみ。テスト品質の 3 観点(プロパティベース、変異、敵対的審査)を実施して結果を完了報告に書く。

## 未決事項

実装をブロックしない事項:

- **MFA 有効期限 30 分、失敗上限 5 回、ロック 15 分、リカバリーコード 8 個、ページサイズ上限 50**: 暫定値。定数のみ変更する。
- **Admin の role 分離(support/operator 等)**: 本タスクは単一の `admin`。運用範囲が広がったら別 Spec。
- **鍵(`ADMIN_TOTP_ENCRYPTION_KEY`、`AUDIT_IP_HASH_KEY`)のローテーション**: 暗号文の版数 `v1` と、複数鍵の同時許容は鍵を替える必要が出たときに設計する。
- **監査ログの保持期間・ユーザー削除時の匿名化**: T-404 で設計する。追記専用 trigger は T-404 の保守用 Migration で扱う。
- **監査ログの閲覧 UI・アラート**: 運用が必要になった時点で別タスク。それまでは Runbook の SQL 手順で確認する。
- **Admin の書き込み操作**(アカウント停止、配送の再送など): 要望と監査・承認フローの設計とともに別 Spec。
- **本番の DB role**: runtime role に `audit_logs` の UPDATE/DELETE/TRUNCATE を与えない設定は T-501/T-502。
- **失敗一覧の index**: 件数が増えたら `status` の部分 index を検討する。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-09
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                 |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Product              | Pass   | 目的、成功指標、範囲/対象外。`docs/02` UC-16、`docs/01` 機能要件 11、`docs/09` T-403                                     |
| Specification        | Pass   | ADM-001〜008、ADM-INV-001〜009、状態遷移、受け入れ基準、失敗・境界ケース。未決事項は非ブロック(暫定値は定数のみ)         |
| Domain and Time      | Pass   | MFA 有効期限の絶対期限と境界(29/30 分・未来時刻)、TOTP のステップ、ロック時刻、Clock 注入。冪等性・並行は条件付き UPDATE |
| API and Data         | Pass   | APIとイベント(コード表、応答例、cursor)、データとMigration(expand のみ、制約・index、fresh/upgrade、rollback)            |
| Security and Privacy | Pass   | セキュリティとプライバシー(権限昇格、MFA、CSRF、内部不正、秘密、ログ禁止)、認可マトリクス、最小露出                      |
| AI                   | N/A    | AI を利用しない(AI ジョブのメタデータを読むのみ)                                                                         |
| Testing              | Pass   | テスト対応表(RFC 6238 ベクトル、プロパティ/変異/敵対的審査、E2E は PR-B)                                                 |
| Operations           | Pass   | 可観測性と運用(監査ログが正本、Runbook、ロールバック、監視は T-501)                                                      |
| Planning             | Pass   | [../plans/minimal-admin.md](../plans/minimal-admin.md)                                                                   |

### 受容リスク

- Rate limit 未実装。MFA は専用のロックアウトで保護し、検索・一覧は完全一致・上限・監査で抑える。
- 管理 API は意図して任意のユーザーの概要を参照できる。マスク・最小項目・全閲覧の監査と、Admin の付与を運用スクリプトに限ることで受容する。
- 監査ログの追記専用は DB trigger による多層防御で、DB 管理者権限を持つ者は迂回できる。本番の runtime role 分離(T-501/T-502)で境界を補う。
- 失敗一覧は全件の `ORDER BY id DESC` で、件数が増えると遅くなる(ベータ規模では許容)。
- AI ジョブの一覧は T-303 まで常に空。
- TOTP の秘密の暗号鍵は環境変数で渡すため、鍵と DB の両方が漏えいすると秘密が復号される(鍵は Secrets Manager、DB は別の権限で分離する前提)。
