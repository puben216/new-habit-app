# データエクスポート Implementation Plan

Status: Done
責任者: TBD
最終更新: 2026-10-13
Spec: [../specs/data-export.md](../specs/data-export.md)
変更区分: Standard

## 方針

T-303(AI queue pipeline)と同じ「job 表 + 条件付き更新の claim + queue port + inline driver」の構成で、アカウント削除(PR-A)の再認証・監査・worker の部品を再利用して縦に薄く実装する。PR-A のブランチ(`feature/t-404-account-deletion`)から積み上げる。

1. **Migration**(`t404_data_export`): `data_exports`(状態・CHECK・部分 unique index・スキャン用 index)と `data_export_artifacts`(成果物の bytea)。`set_updated_at` trigger。`schema.prisma` はコメントで Migration を指す。
2. **Domain**(`packages/domain/src/export/`):
   - 定数: `DATA_EXPORT_FORMATS`、`DATA_EXPORT_STATUSES`、`DATA_EXPORT_TTL_HOURS`(24)、`DATA_EXPORT_MAX_BYTES`(20 MiB)、`DATA_EXPORT_DAILY_LIMIT`(5)、`DATA_EXPORT_MAX_RECEIVE`、`DATA_EXPORT_CLEANUP_BATCH_SIZE`(200)、`DATA_EXPORT_RETENTION_DAYS`(7)。
   - `exportExpiresAt`・`isExportExpired`(`now >= expires_at`)。
   - 出力データの型 `ExportBundle`(許可リスト)と `buildExportJson`。
   - `toCsvCell`(エスケープ・数式の無害化)・`toCsv`・`buildExportCsvFiles`(データ種別ごとの CSV と README)。
   - `buildStoredZip`(無圧縮の ZIP。CRC-32)。
3. **Application**(`packages/application/src/export/`):
   - port: `DataExportRepositoryPort`(`createIfAllowed`、`list`、`findOwned`、`claim`、`complete`、`fail`、`release`、`readArtifact`、`expireDue`、`deleteOld`)、`ExportDataSourcePort`(`collect(userId)` → `ExportBundle`)、`DataExportQueuePort`。再認証は PR-A の `LoginAttemptPort`・`PasswordHasherPort` と `AccountRepositoryPort.findForReauth` を再利用。
   - use case: `requestDataExportUseCase`、`listDataExportsUseCase`、`downloadDataExportUseCase`、`processDataExportUseCase`、`cleanupExpiredDataExportsUseCase`、`handleDataExportMessages`(SQS 形式の batch)。fake を併設。
   - Application error: `ExportInProgressError`、`ExportRateLimitedError`、`ExportNotFoundError`、`ExportNotReadyError`、`ExportExpiredError`、`ExportUnavailableError`。
4. **Infrastructure**(`packages/infrastructure/src/export/`): `PrismaDataExportRepository`(単一文の遷移、部分 unique index による 1 件制限、成果物の保存を同一 transaction)、`PrismaExportDataSource`(`REPEATABLE READ`、許可リストの列挙 SELECT、keyset 分割)、`createInlineDataExportQueue`、`createDataExportProcessDeps`(web/workers 共通の配線)。監査は PR-A と同じ方式で、状態変更と同一 transaction。
5. **Contracts**(`packages/contracts/src/data-export.ts`): `createDataExportRequestSchema`(`.strict()`)、`dataExportResponseSchema`、`dataExportListResponseSchema`、`dataExportMessageV1Schema`。
6. **Config**: `packages/config` に `EXPORT_QUEUE_DRIVER`(本番で `inline` を拒否)と、worker の `DATA_EXPORT_ENABLED`(`isDataExportEnabled`)。`.env.example` に追記。
7. **Presentation**(`apps/web`): `data-export-handlers.ts`・`data-export-container.ts`、route(`/api/v1/me/exports`、`/api/v1/me/exports/[id]/download`)。ダウンロードは `Response` にバイト列とヘッダーを載せる。画面 `/account/export`(`(app)` 配下)、プロフィールの導線。
8. **Worker**(`apps/workers`): `data-export` の SQS handler(部分失敗)と `data-export-cleanup` handler、composition root、手動実行 `pnpm export:cleanup`。
9. **文書**: `docs/04`、`docs/05`、`docs/08`、`docs/09`、`docs/10`、`docs/06`、Runbook(`docs/runbooks/data-export.md`)、`.env.example`。

## 影響分析

| 領域           | 変更                                                                          | リスク                                                                       |
| -------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Domain         | `export/` に定数・純粋関数・型を追加                                          | 低                                                                           |
| Application    | `export/` に use case・port・fake・error を追加。再認証は PR-A の部品を再利用 | 低                                                                           |
| Infrastructure | Prisma repository、データ収集(複数テーブルの読み取り)、inline queue           | 中(許可リスト漏れ=情報の過剰な出力。Unit/Integration で機密値の非出力を検査) |
| Presentation   | route 3 本、handler、画面 1 つ、導線                                          | 中(ファイルのダウンロード応答。所有者・期限・ヘッダーをテスト)               |
| Database       | Migration 1 本(新規テーブル 2)                                                | 低(expand のみ)                                                              |
| API/Event      | 新規 3 エンドポイント、queue message 1 種                                     | 中                                                                           |
| AWS/Terraform  | 変更なし(SQS・Lambda・Schedule は T-501)                                      | 低                                                                           |
| Observability  | Runbook、監査ログ(`user.export.*`)                                            | 低                                                                           |

## インターフェースと契約

- Domain: Spec の「出力するデータ」に対応する `ExportBundle`、`buildExportJson(bundle, exportedAt)`、`buildExportCsvFiles(bundle, exportedAt)`、`toCsvCell`、`buildStoredZip(files, timestamp)`、`exportExpiresAt(completedAt)`、`isExportExpired(expiresAt, now)`。
- Application(主要なもの):
  - `DataExportRepositoryPort.createIfAllowed({ actorUserId, format, now, windowStart, dailyLimit, context }): "created"(+record) | "in_progress" | "rate_limited" | "not_found"`(部分 unique index の衝突は `in_progress`。頻度の数え方・古い ready の無効化・監査を同一 transaction で行う)。
  - `claim({ exportId, leaseSeconds })` → `claimed(record) | not_found | finished | in_progress`、`complete({ exportId, content, byteSize, fileName, contentType, now })` → `completed | lost`、`fail({ exportId, failureCode })`、`release({ exportId })`。
  - `findOwned({ actorUserId, exportId })` → record | null、`readArtifact({ actorUserId, exportId, context, now })`(監査を先に追記してから読む)。
  - `ExportDataSourcePort.collect({ userId }): Promise<ExportBundle>`。
  - `DataExportQueuePort.enqueue({ version: 1, exportId })`。
- Contracts / HTTP: Spec の「APIとイベント」のとおり。

## データMigration

- Expand: 新規テーブル 2 と index・CHECK・trigger。既存のテーブルは変更しない。
- Backfill/Switch/Contract: N/A。
- ロールバック/前方修正: アプリの revert。テーブルを削除する場合は forward Migration を追加する(適用済み Migration は編集しない)。
- 検証: fresh と upgrade(直前の Migration まで適用した DB へ適用)を Integration Test で確認する。

## セキュリティレビュー

- 認証/認可: 全 API が session の actor を使い、全 query に `user_id` を含める。他人の ID は `404`。削除予約中は Member API の一括遮断で `401`。
- 個人情報/Secret/ログ: 出力は許可リストの列挙 SELECT のみ。データの内容・成果物・パスワード・メールをログ・監査・エラー・queue message に出さない。fixture は架空データのみ。
- 悪用対策: 再認証(5 回/15 分の制限)、実行中 1 件、24 時間に 5 件、20 MiB の上限、24 時間の期限、CSV の数式対策、`attachment`・`nosniff`・固定ファイル名、Origin 検証。

## テスト計画

Spec の「テスト対応表」に従う。補足:

- 許可リストの検査: seed に機密値(パスワードのハッシュ、session token、MFA の秘密、他ユーザーの文字列)を入れ、JSON/CSV/ZIP のどこにも現れないことを確認する。出力の項目名の集合を、Spec の表と一致させる。
- スナップショット: 収集中に別の接続で更新・追加を行い(収集の途中で一時停止できる fake の hook を使うか、別 transaction を割り込ませる)、混在しないことを確認する。
- 変異テスト(手動): 許可リストの項目、期限の境界(`>=`)、所有者条件、数式の先頭文字、CRC-32、claim の条件、上限の判定。

## 展開と運用

- Feature Flag: worker のみ(`DATA_EXPORT_ENABLED`、既定は無効)。
- デプロイ順序: Migration → アプリ。worker の配置は T-501 以降。
- メトリクス/アラーム: 追加なし(T-501)。Runbook に確認手順を書く。
- ロールバック条件と手順: 不具合時はアプリを revert。残った成果物は期限で削除される(手動実行 `pnpm export:cleanup`)。

## タスク分解

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Migration + fresh/upgrade の検証
3. Domain(CSV、ZIP、JSON、期限)+ Unit/プロパティテスト
4. Application: port、use case、fake、batch handler + Unit Test
5. Infrastructure: repository、データ収集、inline queue + Integration Test
6. Contracts + Config + Presentation(handler、container、route)+ Unit Test
7. Worker: handler、container、手動実行 + Unit/Integration Test
8. 画面(作成、一覧、ダウンロード、導線)+ E2E
9. 文書更新、品質コマンド一式、3 観点の検証、セルフレビュー、PR-B

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行 task: PR-A(再認証、監査、worker の構成。#37)、T-303(job/queue のパターン)、T-101/T-102(session、プロフィール)。PR-A が未マージの間は、そのブランチを土台にする。
- ADR 依存: [ADR-006](../adr/ADR-006-legal-baseline.md)(データ保持)。外部アカウント/権限/provider: なし。

## リスク

| リスク                                       | 対策                                                                      | 責任者 |
| -------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| 許可リスト漏れで機密値が出力に混ざる         | 列挙 SELECT、機密値の非出力テスト、項目名の集合のテスト                   | TBD    |
| 他人のエクスポートが取得できてしまう         | 全 query に `user_id`、他人の ID は 404、Integration/E2E で検証           | TBD    |
| 生成中の更新で不整合なスナップショットになる | `REPEATABLE READ` の単一 transaction、割り込みの更新を使うテスト          | TBD    |
| 同時作成・重複配送で成果物が複数できる       | 部分 unique index、claim/確定の条件付き更新、並行テスト                   | TBD    |
| 成果物が残り続けて個人データが滞留する       | 24 時間の期限と定期ジョブ、7 日後の行の削除、アカウント削除での CASCADE   | TBD    |
| ZIP の自前実装の誤り                         | CRC-32 の既知ベクトル、往復(自前のパーサ + Node の `zlib.crc32` との照合) | TBD    |

## 着手条件

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(ADR-006)
- [x] API/event契約がレビュー済み(Spec の APIとイベント)
- [x] Migration方針がレビュー済み(Spec のデータとMigration)
- [x] 認可・データ保護方針がレビュー済み(セキュリティとプライバシー)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、既存 fake)
- [x] 依存taskが完了している、または土台のブランチに含まれる(PR-A)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
