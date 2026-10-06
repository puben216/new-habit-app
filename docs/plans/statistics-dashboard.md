# Statistics Dashboard Implementation Plan

Status: Done
Owner: TBD
Last updated: 2026-10-04
Spec: [../specs/statistics-dashboard.md](../specs/statistics-dashboard.md)
Change classification: Standard

## Approach

T-202/T-203 と同じ層構成で縦に薄く実装する。DB の変更はない。

1. **Domain**(`packages/domain/src/tracking/statistics.ts`): 純粋関数のみ。
   - `calculateHabitStatistics({ scheduleVersions, entries, today })`: `[today - 365, today]` の予定機会(`generateOccurrences`)を古い順に結果(`success`/`missed`/`skipped`/`pending`)へ分類し、ストリーク(現在・最長)と 7/30 日の `WindowStatistics` を返す。
   - `aggregateWindowStatistics(windows)`: 件数を合計し、合計から成功率を求める(全体用)。
   - 定数 `STREAK_LOOKBACK_DAYS = 366`、`STATISTICS_WINDOW_DAYS = { short: 7, long: 30 }`。
2. **Application**(`packages/application/src/tracking/`):
   - `HabitEntryRepositoryPort.listByDateRange({ actorUserId, from, to })`(actor の期間内の記録を日付昇順で返す)を追加。
   - `dashboard-use-cases.ts`: `getDashboardUseCase`。`resolveLocalToday` で今日を求め(user 不存在は `UserNotFoundError`)、active 習慣(T-202 の `listAllActiveHabits` を export して再利用)と記録の範囲取得を並行して行い、習慣ごとに Domain 関数を呼ぶ。他の習慣・アーカイブ済み習慣の記録は habit ID で除外する。
3. **Infrastructure**(`packages/infrastructure/src/tracking/prisma-habit-entry-repository.ts`): `listByDateRange` を `findMany`(`userId` と `habitDate` の範囲、`orderBy habitDate asc, id asc`)で実装。既存 index に一致する。
4. **Contracts**(`packages/contracts/src/dashboard.ts`): `dashboardResponseSchema`。
5. **Presentation**(`apps/web`): `dashboard-handlers.ts`(`habit-http.ts` の共通処理を再利用)、`dashboard-container.ts`、`app/api/v1/dashboard/route.ts`(GET)。
6. **文書**: `docs/04`(実装時の補足)、`docs/05`(契約差分: `from`/`to` を持たない)、`docs/09`(roadmap)、`docs/10`(D-13)。

## Impact Analysis

| Area           | Change                                                                              | Risk                                    |
| -------------- | ----------------------------------------------------------------------------------- | --------------------------------------- |
| Domain         | `tracking/` に純粋関数を追加(既存は変更しない)                                      | 低                                      |
| Application    | port に 1 メソッド追加(fake も更新)、use case 追加、`listAllActiveHabits` を export | 低                                      |
| Infrastructure | `findMany` の追加                                                                   | 低(Integration Test で境界・分離を検証) |
| Presentation   | 新規 route 1 件と handler                                                           | 低                                      |
| Database       | 変更なし                                                                            | N/A                                     |
| API/Event      | 新規 endpoint 1 件                                                                  | 低                                      |
| AWS/Terraform  | 変更なし                                                                            | N/A                                     |
| Observability  | 変更なし                                                                            | N/A                                     |

## Interfaces and Contracts

- Domain: `calculateHabitStatistics`、`aggregateWindowStatistics`、型 `StatisticsEntry { date, status }`、`WindowStatistics`、`HabitStatistics`、`OccurrenceOutcome`。
- Application:
  - `HabitEntryRepositoryPort.listByDateRange(input: { actorUserId, from, to }): Promise<readonly HabitEntryRecord[]>`。
  - `getDashboardUseCase(deps, { actorUserId }): Promise<Dashboard>`。`Dashboard { date, timezone, overall: { last7Days, last30Days }, habits: { habit, statistics }[] }`。
- Contracts / HTTP: Spec の API and Events 節のとおり。

## Data Migration

- Expand/Backfill/Switch/Contract: N/A。DB スキーマ変更なし。
- Rollback/forward fix: アプリの revert のみで完結する。

## Security Review

- Authentication/authorization: session から actor を取得し、repository の全 query に actor user ID を渡す。path/query にユーザー・習慣を含めない。
- PII/secrets/logging: 習慣名・記録・集計値をログに出さない。応答は `id`/`kind`/`name` のみで `purpose`/`cue` 等を含めない。fixture は架空データのみ。
- Abuse controls: 取得量は習慣数 × 366 件。Rate limit は Accepted Risk。
- SQL: Prisma の型付き query のみ(raw SQL なし)。

## Test Plan

| Requirement  | Test level  | Planned test                                                                                                                                       |
| ------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| STAT-002/003 | Unit        | `statistics.test.ts`: 分類、今日の未記録は pending、予定外の記録の無視、分母 0/全 skipped、7/30 日の境界、版切替、DST 日、件数の恒等式(性質テスト) |
| STAT-004     | Unit        | `statistics.test.ts`: 連続、missed で切断、skipped/pending は中立、非予定日、最長、366 日の打ち切り                                                |
| STAT-005     | Unit        | `statistics.test.ts`: 合計から率(平均ではない)                                                                                                     |
| STAT-001     | Unit        | `dashboard.test.ts`: 習慣なし、並び順、Asia/Tokyo の繰り上がり、repository 呼び出し回数が習慣数に依らない、user 不存在、actor が repo に渡る       |
| STAT-INV-004 | Unit        | `dashboard.test.ts`: アーカイブ済み習慣・他ユーザーの記録が混ざらない                                                                              |
| 契約         | Unit        | `contracts/dashboard.test.ts`: null/範囲、整数、未知キーの扱い                                                                                     |
| HTTP         | Unit        | `dashboard-handlers.test.ts`: 200/401/404 のマッピング、内部 ID を含めない                                                                         |
| 範囲取得     | Integration | `prisma-habit-entry-repository.integration.test.ts` に追加: 両端含む、範囲外除外、他ユーザー分離、並び                                             |
| STAT-001/005 | Integration | 実 DB で habit・記録を作り `getDashboardUseCase` の応答全体、複数習慣の合算、アーカイブ除外                                                        |

## Rollout and Operations

- Feature Flag: 不要(新規 route のみ)。
- Deployment order: 制約なし(Migration なし)。
- Metrics/alarms: 追加なし。
- Rollback trigger and procedure: 不具合時はアプリを revert する。

## Task Breakdown

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Domain: `statistics.ts` + Unit Test
3. Application: port 追加、`listAllActiveHabits` の export、fake 更新、`getDashboardUseCase` + Unit Test
4. Infrastructure: `listByDateRange` + Integration Test
5. Contracts: schema + Unit Test
6. Presentation: handler、container、route + Unit Test
7. 文書更新(`docs/04`、`05`、`09`、`10`)
8. 品質コマンド一式(`test:integration` を含む)の実行、セルフレビュー

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## Dependencies

- 先行 task: T-201(`generateOccurrences`)、T-202(`resolveLocalToday`、`listAllActiveHabits`、`habit_entries`)、T-203 は直接依存しない。いずれも main に merge 済み(PR #12〜#14)。
- ADR 依存、外部権限、provider: なし。

## Risks

| Risk                                                  | Mitigation                                                                       | Owner |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- | ----- |
| 集計定義が `docs/04` とずれる                         | 差分(pending の除外、skipped の中立)を Spec と D-13 に明記し、docs/04 を更新する | TBD   |
| 記録数が多いユーザーで遅くなる                        | 取得量の上限(習慣数 × 366)。性能が問題になれば SQL 集計を同じ契約テストで検討    | TBD   |
| `generateOccurrences` の範囲上限(366)を超える呼び出し | `STREAK_LOOKBACK_DAYS` を上限と同値にし、Unit Test で境界を確認                  | TBD   |

## Start Conditions

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(該当ADRなし)
- [x] API/event契約がレビュー済み、またはN/A(Spec の API and Events 節)
- [x] Migration方針がレビュー済み、またはN/A(migrationなし)
- [x] 認可・データ保護方針がレビュー済み(Security and Privacy 節)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、既存 fake)
- [x] 依存taskが完了している(T-201/T-202 は main に merge 済み)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
