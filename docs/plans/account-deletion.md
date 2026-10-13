# アカウント削除 Implementation Plan

Status: Done
責任者: TBD
最終更新: 2026-10-13
Spec: [../specs/account-deletion.md](../specs/account-deletion.md)
変更区分: Standard

## 方針

T-401〜T-403 と同じ層構成で、既存の認証・session・監査の部品を再利用して縦に薄く実装する。エクスポートは PR-B として別の Spec/Plan で扱う。

1. **Migration**(`t404_account_deletion`): `users` の CHECK(`status` と `deleted_at` の同値)、期限スキャン用の部分 index、`login_attempts.purpose` に `reauth` を追加。`schema.prisma` はコメントで Migration を指す。
2. **Domain**(`packages/domain/src/account/`): `ACCOUNT_DELETION_GRACE_DAYS`(30)、`ACCOUNT_PURGE_BATCH_SIZE`(50)、`ACCOUNT_STATUSES` と型、`deletionDeadline(deletedAt)`・`isGracePeriodOver(deletedAt, now)`(境界は `now >= deadline`)。
3. **Application**(`packages/application/src/account/`):
   - port: `AccountRepositoryPort`(`findForReauth`、`requestDeletion`(条件付き更新 + session 削除 + 監査を 1 transaction)、`cancelDeletion`、`findDeletionState`、`findDueForPurge`、`purge`(行ロック + 条件再確認 + 監査 + 削除を 1 transaction))、`ExternalDataCleanupPort`、再認証の試行は既存の `LoginAttemptPort` に `reauth` を追加して使う。
   - use case: `requestAccountDeletionUseCase`(制限の確認 → 検証 → 要求)、`cancelAccountDeletionUseCase`、`getAccountDeletionStatusUseCase`、`purgeExpiredAccountsUseCase`。fake を併設。
   - Application error: `ReauthenticationFailedError`、`TooManyAttemptsError`、`DeletionAlreadyRequestedError`、`DeletionNotRequestedError`、`GracePeriodExpiredError`、`AccountNotFoundError`。
4. **Infrastructure**(`packages/infrastructure/src/account/`): `PrismaAccountRepository`(条件付き更新の単一文、`SELECT ... FOR UPDATE`、同一 transaction での監査追記と削除)、`noopExternalDataCleanup`。`PrismaAuthRepository.findSessionDetails` に `userStatus` を追加し、Auth.js の session callback で `session.accountStatus` に載せる。`LoginAttemptPort` の `purpose` に `reauth` を追加(型と DB の CHECK)。
5. **Contracts**(`packages/contracts/src/account-deletion.ts`): `requestAccountDeletionRequestSchema`(`{ password }`、`.strict()`、長さ上限)、`accountDeletionResponseSchema`、`accountDeletionStatusSchema`。
6. **Presentation**(`apps/web`):
   - `actorUserIdFromSession` を `accountStatus === 'deletion_pending'` で `null` にする(中央の遮断)。取り消し・状態取得用に `accountSessionFromAuth`(予約中でも user ID を返す)を追加。
   - `account-deletion-handlers.ts`、`account-deletion-container.ts`、route(`DELETE /api/v1/me` は既存の `me/route.ts` に追加、`me/deletion/route.ts`、`me/deletion/cancel/route.ts`)。
   - `requireSession`・`redirectIfSignedIn` が予約中の session を `/account/restore` へ向ける。画面 `(app)` 配下の `/account/delete`、`(app)` 外の `/account/restore`。プロフィール画面の導線、ログイン画面の案内。
7. **Worker**(`apps/workers`): `purge-expired-accounts` handler と composition root。Feature Flag(`ACCOUNT_PURGE_ENABLED`)が無効の間は DB に接続しない。`packages/config` の `parseWorkerEnv` を拡張する。
8. **文書**: `docs/04`、`docs/05`、`docs/08`、`docs/09`、`docs/10`、Runbook(`docs/runbooks/account-deletion.md`)、`docs/06` の E2E 一覧。

## 影響分析

| 領域           | 変更                                                                                       | リスク                                                                               |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Domain         | `account/` に定数・純粋関数・型を追加                                                      | 低                                                                                   |
| Application    | `account/` に use case・port・fake・error を追加。`LoginAttemptPurpose` に `reauth` を追加 | 低                                                                                   |
| Infrastructure | Prisma repository、`findSessionDetails` と session callback の拡張                         | 高(認証基盤への変更。既存の auth テストを変更せず通す。session の形に項目を足すのみ) |
| Presentation   | 中央の actor 解決の変更(全 Member API に影響)、route 3 本、画面 2 本、ガードの分岐         | 高(全 API の遮断条件。active の挙動が変わらないことを既存テストと E2E 全体で確認)    |
| Database       | Migration 1 本(CHECK、部分 index、CHECK 値の追加)                                          | 低〜中(既存行が条件を満たす前提。fresh/upgrade を検証)                               |
| API/Event      | 新規 3 エンドポイント(`DELETE /me`、`GET /me/deletion`、`POST /me/deletion/cancel`)        | 中                                                                                   |
| AWS/Terraform  | 変更なし(Lambda・Schedule は T-501。handler と Flag までを用意)                            | 低                                                                                   |
| Observability  | Runbook、監査ログ(`user.account.*`、`system.account.purged`)                               | 低                                                                                   |

## インターフェースと契約

- Domain: `ACCOUNT_DELETION_GRACE_DAYS`、`ACCOUNT_PURGE_BATCH_SIZE`、`ACCOUNT_STATUSES`、`AccountStatus`、`deletionDeadline`、`isGracePeriodOver`、監査 action の型 `AccountAuditAction`(`user.account.deletion_requested`、`user.account.deletion_cancelled`、`system.account.purged`)。
- Application:
  - `AccountRepositoryPort.findForReauth(userId): { emailNormalized, passwordHash, status } | null`
  - `requestDeletion({ userId, now, audit }): "requested" | "already_requested" | "not_found"`(条件付き更新の結果。session 削除と監査は同一 transaction)
  - `cancelDeletion({ userId, now, graceMs, audit }): "cancelled" | "not_requested" | "expired" | "not_found"`
  - `findDeletionState(userId): { status, deletedAt } | null`
  - `findDueForPurge({ cutoff, limit }): readonly string[]`、`purge({ userId, cutoff, audit }): "purged" | "skipped"`(行ロック → 条件の再確認 → 監査 → 削除)
  - `ExternalDataCleanupPort.cleanup({ userId, userPublicId }): Promise<void>`(失敗は例外。冪等であること)
  - use case: `requestAccountDeletionUseCase(deps, { actorUserId, password, context })`、`cancelAccountDeletionUseCase`、`getAccountDeletionStatusUseCase`、`purgeExpiredAccountsUseCase(deps): { purged, failed, skipped }`。
- 認証: `AuthSessionDetails` に `userStatus`、`Session`(Auth.js)に `accountStatus`。
- Contracts / HTTP: Spec の「APIとイベント」のとおり。

## データMigration

- Expand: CHECK、部分 index、`login_attempts` の CHECK 値の追加(後方互換。既存のコードは新しい値を使わない)。
- Backfill: N/A(`deleted_at` を書く既存コードなし)。Switch/Contract: N/A。
- ロールバック/前方修正: アプリの revert。CHECK・index・値の追加を戻す場合は forward Migration を追加する。
- 検証: fresh と upgrade(直前の Migration まで適用した DB へ適用)を Integration Test で確認する。

## セキュリティレビュー

- 認証/認可: 削除・取り消し・状態取得は session の actor のみ。予約中の遮断は `actorUserIdFromSession` に集約。再認証は `PasswordHasherPort` で検証し、失敗を `login_attempts`(`reauth`)で制限。
- 個人情報/Secret/ログ: パスワードは検証にのみ使い、ログ・監査・エラーに出さない。ジョブのログは件数のみ。fixture は架空データのみ。
- 悪用対策: 5 回/15 分の制限(制限中は検証しない)、Origin 検証、body 上限、条件付き更新と行ロックによる競合の直列化、Worker は Feature Flag で無効のまま配置。

## テスト計画

Spec の「テスト対応表」に従う。補足:

- 既存の auth・session・各 API のテストを変更せず通す(active の挙動の回帰)。
- 全 FK の CASCADE 検証は `information_schema` から `users` を参照する FK を列挙し、`delete_rule = 'CASCADE'` であることを検査する。
- 変異テスト(手動): 期限の境界(`>=` と `>`)、条件付き更新の条件、遮断の条件、再認証の制限順序、purge の条件再確認、監査と削除の同一 transaction。

## 展開と運用

- Feature Flag: Worker のみ(`ACCOUNT_PURGE_ENABLED`、既定は無効)。
- デプロイ順序: Migration → アプリ。Worker の配置は T-501 以降。
- メトリクス/アラーム: 追加なし(T-501)。Runbook に確認手順を書く。
- ロールバック条件と手順: 不具合時はアプリを revert。誤って削除予約された場合は取り消しで復元できる。ジョブは無効のままにする。

## タスク分解

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Migration + fresh/upgrade の検証
3. Domain + Unit/プロパティテスト
4. Application: port、use case、fake、error + Unit Test
5. Infrastructure: Prisma repository、session の拡張、再認証の制限 + Integration Test
6. Contracts + Presentation(中央の遮断、handler、container、route)+ Unit Test
7. Worker: handler、container、Flag + Unit/Integration Test
8. 画面(削除要求、復元、導線、案内)+ E2E
9. 文書更新、品質コマンド一式(`test:integration`、`test:e2e` を含む)、3 観点の検証、セルフレビュー、PR-A

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行 task: T-101(session、`PasswordHasherPort`)、T-102(プロフィール)、T-402(受信者の解決、suppression)、T-403(監査ログ、`AuditLogPort`)、T-211(画面基盤・E2E)。いずれも main に取り込み済み。
- ADR 依存: [ADR-006](../adr/ADR-006-legal-baseline.md)(猶予 30 日と取り消し)。外部アカウント/権限/provider: なし。

## リスク

| リスク                                                           | 対策                                                                                             | 責任者 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| 中央の遮断で active のユーザーの挙動が壊れる                     | 既存テストを変更せず通す。E2E 全体を実行する。遮断は `accountStatus === 'deletion_pending'` のみ | TBD    |
| 削除ジョブの誤削除(取り消し直後、期限の境界)                     | 行ロックと条件の再確認、境界のプロパティテスト、競合の Integration Test、Flag で無効のまま配置   | TBD    |
| 新しいテーブルが CASCADE なしで `users` を参照し、削除漏れになる | 全 FK の CASCADE を検査するテスト                                                                | TBD    |
| 再認証の制限が通常ログインを巻き込む                             | `purpose = 'reauth'` で分離し、独立をテストする                                                  | TBD    |
| session の形の変更が管理機能(MFA)に影響する                      | 項目の追加のみ。管理機能の既存テストと E2E を通す                                                | TBD    |

## 着手条件

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(ADR-006)
- [x] API/event契約がレビュー済み(Spec の APIとイベント)
- [x] Migration方針がレビュー済み(Spec のデータとMigration)
- [x] 認可・データ保護方針がレビュー済み(セキュリティとプライバシー)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、既存 fake)
- [x] 依存taskが完了している(T-101/T-102/T-402/T-403/T-211)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
