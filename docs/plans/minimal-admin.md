# 最小管理機能 Implementation Plan

Status: In Progress
責任者: TBD
最終更新: 2026-10-09
Spec: [../specs/minimal-admin.md](../specs/minimal-admin.md)
変更区分: Standard

## 方針

T-401/T-402 と同じ層構成で、同じ Spec のもとで 2 本の PR に分けて届ける。

- **PR-A(バックエンド)**: Migration、Domain/Application/契約、Prisma adapter、TOTP と暗号化、監査、`/api/v1/admin/*`、運用スクリプト、session への MFA 検証時刻の組み込み。画面はまだ無い。
- **PR-B(画面と E2E)**: `/admin/*` の最小画面(read-only)、route の保護、Playwright E2E、Runbook。

手順(PR-A):

1. **Migration**(`t403_minimal_admin`): `admin_users`、`admin_recovery_codes`、`sessions.mfa_verified_at`、`audit_logs` の追記専用 trigger と index。`schema.prisma` を更新(trigger・CHECK・部分 index はコメントで Migration を指す)。
2. **Domain**(`packages/domain/src/admin/`): 定数(`ADMIN_MFA_TTL_MS` ほか)、`maskEmail`、`isMfaFresh`、`parseMfaCode`(TOTP/リカバリーコードの正規化)、`AdminAuditAction` の型、`generateRecoveryCodes` の形式検証。
3. **Application**(`packages/application/src/admin/`):
   - port: `AdminAccountRepositoryPort`、`SessionMfaPort`、`TotpPort`、`RecoveryCodePort`、`AuditLogPort`、`AdminReadPort`(検索・概要・一覧)。
   - use case: `authorizeAdmin`、`verifyAdminMfaUseCase`、`searchUserByEmailUseCase`、`getUserOverviewUseCase`、`listNotificationFailuresUseCase`、`listAiJobFailuresUseCase`(閲覧は監査を先に追記)、`grantAdminUseCase`/`disableAdminUseCase`/`resetAdminMfaUseCase`(運用)。fake を併設。
4. **Infrastructure**(`packages/infrastructure/src/admin/`): `PrismaAdminRepository`(条件付き `UPDATE` で失敗カウント・replay・リカバリーコードを原子的に処理)、`PrismaSessionMfaRepository`、`PrismaAuditLogRepository`、`PrismaAdminReadRepository`、`totp.ts`(RFC 6238、base32、otpauth URI)、`secret-box.ts`(AES-256-GCM)、`recovery-codes.ts`、`ip-hasher.ts`(HMAC)。既存の `AuthRepositoryPort.findSessionUser` に `sessionId` と `mfaVerifiedAt` を追加し、Auth.js の session callback で `session` に載せる(`AdminAccessPort` が参照)。
5. **Contracts**(`packages/contracts/src/admin.ts`): request/response/query の runtime schema(`.strict()`、応答は allowlist)。
6. **Presentation**(`apps/web`): `admin-handlers.ts`(共通の guard: 401/404/403/429、Origin 検証、request ID、IP のハッシュ)、`admin-container.ts`、route 6 本。`packages/config` に `ADMIN_TOTP_ENCRYPTION_KEY`・`AUDIT_IP_HASH_KEY` を追加(未設定でも他の機能は起動できる。管理 API は使うときに検査して失敗)。
7. **運用スクリプト**: `packages/infrastructure/scripts/admin.ts`(`grant`/`disable`/`reset-mfa`)。実行には `tsx`(devDependency、exact)を使う。ルートの `pnpm admin:*`。
8. **文書**: `docs/04`、`docs/05`、`docs/08`、`docs/09`、`docs/10`、ADR-012、`docs/runbooks/admin-operations.md`。

手順(PR-B):

9. **画面**(`apps/web/src/app/(admin)/admin/…`): layout(Server Component)で `requireAdmin()` を実行 — 未認証 → `/login?next=`、Admin でない → `notFound()`、MFA 未検証 → `/admin/mfa`。画面は型付き API client と TanStack Query で `/api/v1/admin/*` を呼ぶ(ADR-010)。a11y(skip link、landmark、focus)と noindex。
10. **E2E**(Playwright): member 拒否、admin の MFA 未検証→検証→閲覧、検索、失敗一覧、監査行の確認。E2E 用の Admin はテストヘルパーで DB に直接作る(E2E 専用の暗号鍵)。
11. **文書・CI**: Runbook の追記、`docs/06` の E2E 一覧。

## 影響分析

| 領域           | 変更                                                                                             | リスク                                                              |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Domain         | `admin/` に定数・純粋関数・型を追加                                                              | 低                                                                  |
| Application    | `admin/` に use case・port・fake を追加。`AuthRepositoryPort.findSessionUser` の戻り値に項目追加 | 中(認可の判定順序、fail closed の監査。Unit で網羅)                 |
| Infrastructure | Prisma repository、TOTP、暗号化、IP ハッシュを追加。Auth.js の session callback を拡張           | 高(認証基盤への変更。既存の auth 関連テストを変更せず通す)          |
| Presentation   | 管理 API の route 6 本と handler(PR-A)、画面(PR-B)                                               | 中(権限分離。404/403/401 の同一性をテスト)                          |
| Database       | Migration 1 本(新テーブル 2、`sessions` に列、`audit_logs` に trigger/index)                     | 中(`audit_logs` の追記専用化。既存行なし前提、fresh/upgrade を検証) |
| API/Event      | 管理 API 6 本                                                                                    | 中                                                                  |
| AWS/Terraform  | 変更なし(鍵の Secrets Manager の器と ECS への注入は T-501)                                       | 低                                                                  |
| Observability  | Runbook、監査ログ                                                                                | 低                                                                  |

## インターフェースと契約

- Domain: `ADMIN_MFA_TTL_MS`、`ADMIN_MFA_MAX_FAILED_ATTEMPTS`、`ADMIN_MFA_LOCKOUT_MS`、`ADMIN_RECOVERY_CODE_COUNT`、`ADMIN_PAGE_SIZE_MAX`、`maskEmail`、`isMfaFresh`、`parseMfaCode`、`AdminAuditAction`。
- Application:
  - `authorizeAdmin(deps, { actorUserId, mfaVerifiedAt, now }): Promise<{ status: "not_admin" } | { status: "mfa_required"; admin: AdminIdentity } | { status: "granted"; admin: AdminIdentity }>`。`AdminIdentity { adminId, adminPublicId }`。
  - `verifyAdminMfaUseCase(deps, { actorUserId, sessionId, code, context }): "verified" | "invalid" | { status: "locked"; retryAfterSeconds }`。
  - 閲覧 use case は `AdminIdentity` と `AdminRequestContext { requestId, ipHash }` を受け取り、`AuditLogPort.append` が成功してから `AdminReadPort` を呼ぶ。
  - `AdminReadPort`: `findUserByEmail(emailNormalized)`、`getUserOverview(publicId, since)`、`listNotificationFailures({ statuses, limit, afterId })`、`listAiJobFailures(…)`。戻り値は allowlist の項目のみ(DTO に email を含めない。マスクは use case で行う)。
- Contracts / HTTP: Spec の「APIとイベント」のとおり。

## データMigration

- Expand: 新テーブル 2、`sessions.mfa_verified_at`(NULL 許容)、`audit_logs` の trigger と index。
- Backfill: N/A(既存の session は未検証のまま。既存の `audit_logs` 行なし)。
- Switch: N/A(Admin が作られるまで管理 API は常に `401`/`404`)。
- Contract: N/A。
- ロールバック/前方修正: アプリの revert。trigger/テーブルが問題なら forward Migration で外す。
- 検証: fresh と upgrade(既存の session 行・audit_logs 行がある状態から)を Integration Test で確認する。

## セキュリティレビュー

- 認証/認可: Admin の判定は毎回 DB(`admin_users`)。Member には管理 route を `404` で秘匿。MFA は session 単位の絶対期限 30 分。付与は運用スクリプトのみ。
- 個人情報/Secret/ログ: email はマスク表示のみ。TOTP の秘密は AES-256-GCM(AAD に admin ID)、リカバリーコードはハッシュのみ。鍵・コード・秘密・email をログ・監査ログ・エラーに含めない。fixture は架空データのみ。
- 悪用対策: 失敗 5 回で 15 分ロック(ロック中はコードを調べない)、replay 防止、定数時間比較、完全一致のみの検索、閲覧前の監査(fail closed)、`audit_logs` の追記専用化、Origin 検証、body 上限。

## テスト計画

| 要件                | テスト種別       | 予定テスト                                                                                                                                                         |
| ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADM-INV-003/006/009 | Unit             | `admin/*.test.ts`: `maskEmail`(プロパティ: local 部が復元できない)、`isMfaFresh`(29/30 分・未来時刻)、`parseMfaCode`(境界・正規化)                                 |
| ADM-003             | Unit             | `totp.test.ts`(RFC 6238 のテストベクトル、±1 ステップ、桁・長さ、プロパティ)、`secret-box.test.ts`(往復、改ざん、AAD 違い)、`recovery-codes.test.ts`               |
| ADM-002/003         | Unit             | `authorize-admin.test.ts`、`verify-admin-mfa.test.ts`(成功/失敗/ロック/replay/リカバリー/並行/ロック中は照合しない)                                                |
| ADM-004〜007        | Unit             | `admin-read.test.ts`(監査が先、監査失敗で閲覧しない、マスク、cursor)                                                                                               |
| ADM-001             | Unit             | `provision-admin.test.ts`(grant/disable/reset、対象の検証、一度きりの表示)                                                                                         |
| 契約                | Unit             | `contracts/admin.test.ts`(未知キー、allowlist、limit/cursor/status)                                                                                                |
| HTTP                | Unit             | `admin-handlers.test.ts`(401/404/403/429 の同一性、Origin、413/415/422、応答に余計な項目がない、request ID/IP のハッシュ)                                          |
| ADM-001〜003        | Integration      | `prisma-admin-repository.integration.test.ts`(失敗カウントの原子性、並行 6 件で 1 回だけ成功、replay、ロック、リカバリーコードの単回使用、session の MFA、CASCADE) |
| ADM-004〜007        | Integration      | `prisma-admin-read-repository.integration.test.ts`(完全一致、集計、keyset、他の列が漏れない)                                                                       |
| ADM-INV-004/005     | Integration      | `prisma-audit-log-repository.integration.test.ts`(追記、UPDATE/DELETE/TRUNCATE の拒否、各閲覧で 1 行、email が残らない)                                            |
| Migration           | Integration      | fresh と upgrade                                                                                                                                                   |
| 回帰                | Unit/Integration | 既存の auth テスト(`findSessionUser` の拡張でも変更せず通る)                                                                                                       |
| 画面/E2E            | E2E(PR-B)        | member 拒否、admin 未 MFA、MFA 検証→検索・概要・失敗一覧、監査行                                                                                                   |

テスト品質の 3 観点: (1) プロパティベース(`maskEmail`、TOTP、暗号化、コード正規化)、(2) 変異テスト(Stryker 未導入。認可の順序・境界・ロック・監査の順序を手動で壊して検知を確認)、(3) 敵対的審査(権限昇格、replay、総当たり、列挙、監査回避を攻撃者の視点で見直し、結果を報告)。

## 展開と運用

- Feature Flag: 不要(Admin が作られるまで管理 API は `401`/`404`)。
- デプロイ順序: Migration → アプリ → (必要なときに)`admin:grant`。鍵 2 つ(`ADMIN_TOTP_ENCRYPTION_KEY`、`AUDIT_IP_HASH_KEY`)を先に Secrets Manager に入れる。
- メトリクス/アラーム: Spec の「可観測性と運用」。専用 metric は追加しない。
- ロールバック条件と手順: 不具合時はアプリを revert。管理者の誤付与は `admin:disable`。

## タスク分解

PR-A:

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Migration + fresh/upgrade の検証
3. Domain + Unit/プロパティテスト
4. Infrastructure の暗号・TOTP・コード生成(純粋部分)+ Unit/プロパティテスト
5. Application: port、use case、fake + Unit Test
6. Infrastructure: Prisma repository、session の拡張 + Integration Test
7. Contracts + Presentation(handler、container、route)+ Unit Test
8. 運用スクリプト + Integration Test
9. 文書更新(`docs/04`、`05`、`08`、`09`、`10`、ADR-012、Runbook)、品質コマンド一式、3 観点の検証、セルフレビュー、PR-A

PR-B:

10. 画面(layout の guard、MFA、ユーザー検索・概要、通知失敗、AI ジョブ失敗)+ Unit/component テスト
11. E2E(Admin の seed ヘルパー、5 シナリオ)
12. 文書、品質コマンド一式(`pnpm test:e2e` を含む)、セルフレビュー、PR-B

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行 task: T-101(session)、T-402(`notification_deliveries`、suppression)、T-211(画面基盤。PR-B)。いずれも main に取り込み済み。AI ジョブの実データは T-303 以降。
- ADR 依存: [ADR-001](../adr/ADR-001-authentication.md)(Admin の TOTP は T-403)。新しい ADR-012 で Admin のアクセス方式を記録する。
- 外部アカウント/権限: なし。`tsx` を devDependency に追加する。

## リスク

| リスク                                                                     | 対策                                                                                        | 責任者 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| 認証基盤(`findSessionUser`、session callback)の変更で既存の login が壊れる | 追加のみ(既存の戻り値を維持)。既存の auth テストを変更せず通す。E2E の login も確認         | TBD    |
| 404/403 の差から Admin の存在が推測される                                  | Member には常に 404、応答本文・ヘッダーの同一性をテスト。MFA 未検証の Admin だけが 403      | TBD    |
| 監査の書き忘れ                                                             | 閲覧 use case の入口を 1 つの helper(監査 → 実行)に集約し、テストで全 use case の監査を検証 | TBD    |
| TOTP の実装ミス                                                            | RFC 6238 の公開ベクトル、プロパティ、変異で検証。HMAC-SHA1(認証アプリの互換性のため)        | TBD    |
| 差分が大きい                                                               | PR-A/PR-B に分割                                                                            | TBD    |

## 着手条件

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(ADR-001)
- [x] API/event契約がレビュー済み(Spec の APIとイベント)
- [x] Migration方針がレビュー済み(Spec のデータとMigration)
- [x] 認可・データ保護方針がレビュー済み(セキュリティとプライバシー)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、RFC 6238 ベクトル)
- [x] 依存taskが完了している(T-101、T-402、T-211)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
