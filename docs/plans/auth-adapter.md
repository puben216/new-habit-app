# Auth Adapter and Session Implementation Plan

Status: Draft
Owner: TBD
Last updated: 2026-09-17
Spec: [../specs/auth-adapter.md](../specs/auth-adapter.md)
Change classification: Standard

本 Plan は Spec の決定事項(password hash は `users` へ直接保持、email verification 必須化、login rate limit は email 単位で直近 15 分 5 回失敗→15 分 lockout、IP ベース rate limit は含めない、Google/GitHub OAuth は MVP スコープ外、Admin TOTP 2FA は T-403、Auth.js 標準 route は [ADR-009](../adr/ADR-009-api-style.md) に基づき `/api/v1` の例外)を前提に設計する。Spec の Open Question は解決済みであり、実装は Task 1 から着手できる。

## Approach

Auth.js(NextAuth v5系)を `apps/web` に統合し、DB session 戦略で `@auth/prisma-adapter` を使って `packages/infrastructure/database` の Prisma Client に永続化する。Credentials provider は Auth.js の標準機構だけでは password hash 検証・rate limit・email verification を賄えないため、これらは `packages/application` に置く use case として実装し、Credentials provider の `authorize` からはこの use case を呼ぶだけにする。

依存方向は既存の dependency-cruiser ルール(Domain は独立、Application は Infrastructure/apps に依存しない)を維持する。

- `packages/domain/src/auth/`: password policy 検証(AUTH-002)、token 有効期限判定、email 正規化(Business Rules 準拠)など、外部ライブラリに依存しない純粋ロジックのみを置く。
- `packages/application/src/auth/`: signup/login/logout/password-reset/email-verification の use case。port を定義し、実装は Infrastructure に委ねる。
- `packages/infrastructure/src/auth/`: port の実装(argon2id hasher、crypto ベースの token generator、Prisma 経由の repository)。Auth.js の `PrismaAdapter` 設定もここに置く。
- `apps/web/src/app/api/`: Auth.js の route handler と、signup/verify-email/password-reset の Route Handler。Application の use case を呼ぶだけの薄い層にする。

## Impact Analysis

| Area           | Change                                                                                                               | Risk |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ---- |
| Domain         | `packages/domain/src/auth/` を新規追加(password policy、token 有効期限判定、email 正規化)                            | 低   |
| Application    | `packages/application/src/auth/` を新規追加(use case、port 定義)。初めて中身が入る                                   | 中   |
| Infrastructure | `packages/infrastructure/src/auth/` を新規追加(Prisma repository、hasher、token生成、email sender)                   | 中   |
| Presentation   | `apps/web/src/app/api/*` を新規追加                                                                                  | 中   |
| Database       | `users` へ列追加、`sessions`/`verification_tokens`/`password_reset_tokens`/`login_attempts` を新規追加する migration | 高   |
| API/Event      | 新規 endpoint 追加のみ、既存 endpoint への影響なし                                                                   | 低   |
| AWS/Terraform  | 変更なし(T-501 以降の対象)                                                                                           | N/A  |
| Observability  | login/lockout/reset のログ・メトリクスを新規追加                                                                     | 低   |

## Interfaces and Contracts

`@habit-app/domain`(追加):

- `assertPasswordPolicy(password: string): void`(AUTH-002: trim 後 8〜128 文字、制御文字拒否。判定にのみ trim を使い、返り値・呼び出し元へは元の文字列をそのまま渡す。違反時は `InvalidPasswordError`)。
- `isTokenExpired(expiresAt: Date, now: Date): boolean`。
- `normalizeEmail(email: string): string`(Business Rules 準拠: trim、local/domain 小文字化、NFC 正規化。IDN punycode 変換は行わない)。

`@habit-app/application`(追加、新規に中身が入る):

- Port:
  - `PasswordHasherPort`(`hash(password): Promise<string>` / `verify(password, hash): Promise<boolean>`)
  - `TokenGeneratorPort`(`generate(): { plaintext: string; hash: string }`)
  - `EmailSenderPort`(`sendVerificationEmail(to, token)` / `sendPasswordResetEmail(to, token)`)
  - `AuthRepositoryPort`(user の password hash 読み書き、verification/reset token の CRUD を単一トランザクションで扱えるインターフェース)
  - `LoginAttemptPort`(`record(purpose, emailNormalized, succeeded)` / `isBlocked(purpose, emailNormalized): Promise<boolean>` / `pruneExpired(): Promise<void>`。`pruneExpired` は判定ウィンドウを超えた履歴を削除する。Spec の retention 要求(AUTH-010)を満たすため、`record` の呼び出しごとに一定確率で実行する opportunistic cleanup として実装する)
- Use case: `signUp`、`verifyEmail`、`resendVerification`、`login`(Credentials provider の `authorize` から呼ぶ)、`requestPasswordReset`、`confirmPasswordReset`。
- すべての use case は AUTH-INV-002(enumeration 対策)を守るため、内部の成否に関わらず呼び出し元へ返す結果の型を統一する(例: `RequestAcceptedResult`)。`login` use case は email 不存在時にも `PasswordHasherPort.verify` をダミーハッシュに対して呼び出し、存在確認の有無で処理経路(および概算処理時間)が分岐しないようにする。

`@habit-app/infrastructure`(追加):

- `PrismaAuthRepository`(`AuthRepositoryPort` 実装。token 検証系メソッドは `SELECT ... FOR UPDATE` を用いた単一トランザクションで実装し、AUTH-INV-001(並行リクエストで最大1件成功)を保証する)。
- `Argon2PasswordHasher`(`PasswordHasherPort` 実装)。
- `CryptoTokenGenerator`(`TokenGeneratorPort` 実装、Node `crypto.randomBytes` + `crypto.createHash("sha256")` で hash 化)。
- `PrismaLoginAttemptRepository`(`LoginAttemptPort` 実装、`login_attempts` テーブル)。
- `EmailSenderPort` の実装は環境ごとに差し替える(詳細は Rollout and Operations 節):
  - `InMemoryEmailSender`(Unit/Integration Test 用の fake。プロセス内メモリに保持し、テストコードから直接参照する。DB・ログのいずれにも書き込まない)。
  - `SmtpEmailSender`(dev/E2E 用。ローカルの Mailpit(SMTP キャプチャツール)へ実際に SMTP 送信する)。
  - `SesEmailSender`(T-401 で実装、本番用。現時点では未実装)。
- Auth.js `authOptions`(Credentials provider 設定、`PrismaAdapter`、session strategy: `database`)。

`apps/web`(追加):

- `app/api/auth/[...nextauth]/route.ts`
- `app/api/v1/auth/signup/route.ts`
- `app/api/v1/auth/verify-email/route.ts`
- `app/api/v1/auth/verify-email/resend/route.ts`
- `app/api/v1/auth/password-reset/route.ts`
- `app/api/v1/auth/password-reset/confirm/route.ts`

Auth.js 標準 route のみ `/api/auth/*` のままとする([ADR-009](../adr/ADR-009-api-style.md) が外部ライブラリの標準 endpoint を `/api/v1` の例外として認めているため、`/api/v1` 配下への移動は不要)。

## Data Migration

Expand のみで、既存データへの backfill は不要(新規機能のため)。

- `users` に列追加: `password_hash text not null`、`email_verified_at timestamptz nullable`。Credentials のみを扱う MVP では password を持たない user が存在しないため `not null` とする(OAuth 追加時に nullable へ変更する migration が必要になる)。`email_normalized` の既存 UNIQUE 制約(T-004 で追加済み)をそのまま利用する。
- 新規テーブル(Auth.js Prisma adapter 標準スキーマ準拠): `sessions`(DB session)、`verification_tokens`(Auth.js 標準の汎用 token、email verification に使用)。OAuth 用の `accounts` テーブルは MVP スコープ外のため作らない(将来 OAuth 追加時に別 migration で追加する)。
- 新規テーブル `password_reset_tokens`: `id`, `user_id`, `token_hash`(UNIQUE), `expires_at`, `used_at nullable`, `created_at`。
- 新規テーブル `login_attempts`: `id`, `purpose`(`signup|login|verify_resend|password_reset`), `email_normalized`, `attempted_at`, `succeeded boolean`。email 単位のみで判定するため IP 列は持たない(Spec Out of Scope)。Index: `(purpose, email_normalized, attempted_at desc)`。retention: 判定ウィンドウ(Spec 確定値: 15 分)を超えた行は `LoginAttemptPort.pruneExpired` による opportunistic cleanup で削除する(Task 6、Spec の retention 要求をこの Plan のスコープ内で満たす)。閾値(15 分 5 回、15 分 lockout)は `packages/config` の設定値として外出しし、コード変更なしで調整可能にする。
- 平文 token を保持する専用テーブルは作らない。開発/テストでのメール内容確認は `InMemoryEmailSender`(Integration Test)と Mailpit(E2E、アプリの DB とは独立したローカルツール)で行う(Rollout and Operations 節)。
- Switch/Contract: 該当なし(新規機能であり既存読み取りパスの切り替え・旧列削除は発生しない)。
- Rollback/forward fix: 認証データを含む migration のため down migration は前提にしない。問題発生時は application code を revert し、追加した列・テーブルはそのまま残す。migration 自体の不具合は新しい forward-fix migration で対応し、データ破損時のみ backup restore を行う(既存 `04-database-design.md` の migration 方針と同じ)。
- 実装時に `04-database-design.md` へ追記する。

## Security Review

- Authentication/authorization: 本 Plan は認証基盤そのものを実装する。認可(ownership 等)は T-104 以降が `session` から取得した actor user ID を用いて個別実装する。
- PII/secrets/logging: password/token の平文を DB・ログに残さない(argon2id hash、token は sha256 hash 化して保存)。開発/テスト用のメール送信(`InMemoryEmailSender`、Mailpit)はいずれもアプリの永続 DB に平文を書き込まない設計とする。
- Abuse controls: AUTH-010 の rate limit/lockout(email 単位、直近 15 分 5 回失敗→15 分 lockout)を `login_attempts` テーブルで実装する。判定は `SELECT COUNT(*) WHERE purpose=? AND email_normalized=? AND attempted_at > now() - window` による直近ウィンドウ集計。record の insert と判定 SELECT の間に race condition があり得るが、rate limit は多少の緩みを許容する性質の防御(hard security boundary ではない)ため、MVP では厳密な atomic counter を採用しない。DB 障害時(`login_attempts` への insert/select が失敗する場合)は fail-open(rate limit 判定をスキップしてログイン処理自体は継続)とする。認証自体が DB 依存のため DB 障害時は多くの場合ログイン自体が機能せず、fail-closed にしても可用性上の追加メリットが小さい一方、fail-closed は「DB が少し不安定なだけで全ユーザーがログインできなくなる」新たな可用性リスクを生むため。
- IP ベースの rate limit は Spec Out of Scope のため実装しない。ECS Fargate + ALB 経由の client IP 取得(`X-Forwarded-For` の信頼境界)は、将来 IP 単位判定を追加する際に別 Spec/Plan で検討する。

## Test Plan

| Requirement  | Test level  | Planned test                                                                                                                          |
| ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-001     | Integration | 重複 email signup で応答が初回と区別できないこと、account が実際には作成されないこと                                                  |
| AUTH-002     | Unit        | 境界値(7/8/128/129 文字)、trim 後長判定、制御文字拒否、先頭・末尾空白ありパスワードがそのままハッシュ化・照合されること               |
| AUTH-002     | Integration | policy 違反時の `422` とフィールドエラー                                                                                              |
| AUTH-003     | Unit        | token 有効期限判定(`isTokenExpired`)                                                                                                  |
| AUTH-003     | Integration | 有効/期限切れ/使用済み token の検証結果                                                                                               |
| AUTH-004     | Integration | 再送時に旧 token が無効化されること、rate limit 超過時の応答統一                                                                      |
| AUTH-005     | Integration | 正常ログイン成功、不存在/不一致/email 未確認/lockout 中で同一 generic error、email 不存在時に dummy hash 検証が実行されること         |
| AUTH-006     | Integration | logout 後に session が DB から失効していること                                                                                        |
| AUTH-007     | Integration | 存在しない email でも同一成功レスポンス                                                                                               |
| AUTH-008     | Integration | reset 成功後の password 更新、token 再利用拒否、既存 session 全失効                                                                   |
| AUTH-009     | Unit        | session オブジェクトから actor user ID を取り出すマッピング関数                                                                       |
| AUTH-010     | Integration | 閾値到達での応答統一、時間経過後の解除、`pruneExpired` によるウィンドウ超過履歴の削除                                                 |
| AUTH-INV-001 | Integration | 同一 token への並行検証/確定リクエストで成功が 1 件のみになること(トランザクション lock の検証)                                       |
| AUTH-INV-002 | Integration | signup/verification 再送/login/password reset request の応答(status/body)が存在有無で差がないこと。login での dummy hash 検証実行確認 |
| 全体         | E2E         | signup → verify(Mailpit から token 取得)→ login → logout、password reset の一連                                                       |

## Rollout and Operations

- Feature Flag: 不要。新規 route 追加のみで既存導線に影響しない。
- 開発/テスト用メール送信: Unit/Integration Test は `InMemoryEmailSender` をテストコードから直接注入し、送信内容をメモリ上で検証する(DB を経由しない)。E2E とローカル開発では Docker Compose に Mailpit(SMTP キャプチャ用のローカル専用ツール、本番相当の DB や migration とは独立)を追加し、`SmtpEmailSender` が実際に SMTP 送信したメールを Mailpit の HTTP API から取得して token を検証する。どの実装を使うかは env(`AUTH_EMAIL_SENDER=smtp|ses`)で切り替え、本番デプロイ設定では `smtp` を許可しない(起動時に env を検証し、本番で `smtp` が指定されていたら起動を失敗させる)。
- Deployment order: DB migration を先に apply してから application code をデプロイする(新規列・テーブルのみの追加のため、通常の expand で安全)。
- Metrics/alarms: login 失敗率、lockout 発動回数を新規に計測対象へ追加。
- Rollback trigger and procedure: application code は即時 revert する。migration は down migration を前提にせず、追加した列・テーブルは残したまま forward-fix migration で問題箇所を修正する(Data Migration 節参照)。
- Runbook: (1) lockout の手動解除は `login_attempts` の該当 `email_normalized` 行を無効化するオペレーション手順を用意する。(2) reset token の不正発行が疑われる場合、該当 `password_reset_tokens` を一括失効させる手順を用意する。

## Task Breakdown

1. `packages/domain/src/auth/` 実装(password policy、token 有効期限判定、email 正規化)+ Unit Test。
2. Prisma schema へ `password_hash`/`email_verified_at` 列と `sessions`/`verification_tokens`/`password_reset_tokens`/`login_attempts` テーブルを追加し migration 作成。Testcontainers で fresh migration 適用を確認。`04-database-design.md` に追記。
3. `packages/application/src/auth/` の port 定義と use case(signUp/verifyEmail/resendVerification/login/requestPasswordReset/confirmPasswordReset)実装 + Unit Test(fake port を注入、AUTH-INV-002 の応答統一を検証)。
4. `packages/infrastructure/src/auth/` の port 実装(`PrismaAuthRepository`、`Argon2PasswordHasher`、`CryptoTokenGenerator`、`PrismaLoginAttemptRepository`、`InMemoryEmailSender`、`SmtpEmailSender`)+ Integration Test(実 DB、AUTH-INV-001 のトランザクション lock 検証を含む)。
5. Auth.js `authOptions` 設定(Credentials provider、`PrismaAdapter`、session strategy: database)、`apps/web/src/app/api/*` route handler 実装 + Integration Test。
6. Rate limit/lockout を各 use case に組み込み、`LoginAttemptPort.pruneExpired` による retention cleanup を実装 + Integration Test(fail-open 挙動、cleanup 動作の確認を含む)。
7. Docker Compose に Mailpit を追加し、E2E(signup→verify(Mailpit 経由)→login→logout、password reset の一連)を実装。
8. 品質コマンド一式(`format:check`/`lint`/`lint:boundaries`/`typecheck`/`build`/`test:unit`/`test:integration`)実行と確認、Roadmap ステータス更新、PR 作成。

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## Dependencies

- 先行 task: T-001〜T-005(完了済み)。T-103(完了済み、依存なし)。
- ADR: [ADR-001](../adr/ADR-001-authentication.md)(accepted、2026-09-16 改訂)。
- 外部 provider: なし(OAuth は MVP スコープ外のため、Google/GitHub client 登録は不要)。

## Risks

| Risk                                                                                                             | Mitigation                                                                                                                           | Owner |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Auth.js v5 系と Prisma 7 系の互換性(`@auth/prisma-adapter` の対応バージョン)が未検証                             | Task 4(Infrastructure の `PrismaAdapter` 実装)着手前に依存バージョンを検証し、非互換なら代替(手動 adapter 実装)を検討する            | TBD   |
| `login_attempts` の rate limit 判定に race condition があり、閾値超過をわずかに見逃す可能性                      | hard security boundary ではなく abuse 抑制目的と位置付け、深刻化すれば Task 6 で atomic な実装(unique constraint 併用等)に切り替える | TBD   |
| `pruneExpired` の opportunistic cleanup が呼ばれる頻度が低い場合、削除が遅延する                                 | 呼び出し頻度(rate limit 判定発生ごと)で通常は十分だが、運用データを見て頻度不足なら明示的な定期実行に切り替える                      | TBD   |
| Mailpit が E2E/ローカル開発以外の環境で利用できない                                                              | Mailpit は Docker Compose のみに追加し、CI の E2E ジョブでも同じ Compose 構成を使う                                                  | TBD   |
| 将来 OAuth を追加する際、`users.password_hash` が `not null` のため migration で `nullable` に変更する必要がある | OAuth 追加 Spec の Task として明記しておく(本 Plan の対象外)                                                                         | TBD   |

## Start Conditions

- [x] Spec Status が Ready(2026-09-17 レビューで Ready)
- [x] 必須 ADR が Accepted([ADR-001](../adr/ADR-001-authentication.md)、[ADR-009](../adr/ADR-009-api-style.md))
- [x] API/event 契約がレビュー済み(Auth.js 標準 route の `/api/v1` 例外は [ADR-009](../adr/ADR-009-api-style.md) により確定。Spec の API and Events 節で全 endpoint 定義済み)
- [x] Migration 方針がレビュー済み(password hash 保存先、email 一意性制約の扱いは確定済み。テーブル一覧は Data Migration 節を参照)
- [x] 認可・データ保護方針がレビュー済み(Spec Security and Privacy 節)
- [x] テスト環境と Fake/Stub を準備できる(Vitest + Testcontainers、fake port を注入可能な設計、`InMemoryEmailSender`、Mailpit)
- [x] 依存 task が完了している(T-001〜T-005、T-103 完了済み)
- [x] rollout/rollback 方針が決定している(forward-fix 重視、down migration を前提にしない)
- [x] 実装前ゲートの全必須項目が Pass または根拠付き N/A(Spec Implementation Readiness 参照)
