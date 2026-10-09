# Weekly Review Implementation Plan

Status: Done
Owner: TBD
Last updated: 2026-10-06
Spec: [../specs/weekly-review.md](../specs/weekly-review.md)
Change classification: Standard

## Approach

T-203/T-204 と同じ層構成で縦に薄く実装する。DB は CHECK 制約の追加(expand)のみ。

1. **Domain**(`packages/domain/src/tracking/`):
   - `statistics.ts`: 結果分類を `outcomeOf(recorded, date, today)` として切り出し、`calculateHabitStatistics` と共有する(挙動は変えない)。任意範囲の件数を求める `calculateRangeStatistics({ scheduleVersions, entries, from, to, today })` を追加。
   - `weekly-review.ts`: `weekEndOf`、`REVIEW_MAX_WEEKS_BACK`、`buildWeeklyReviewSummary`(習慣ごと・全体・チェックインの集計。週内に予定がない習慣は除外)、`normalizeWeeklyReflection`、`WEEKLY_REVIEW_REFLECTION_MAX_LENGTH`、`InvalidWeeklyReviewError`。
2. **Application**(`packages/application/src/tracking/`):
   - `DailyCheckInRepositoryPort.listByDateRange`(週の集計用)を追加し fake も更新。
   - `weekly-review-ports.ts`: `WeeklyReviewRepositoryPort`(`findByWeekStart`、`createIfAbsent`、`findById`、`list`、`update`)。`update` は結果を `ok`/`not_found`/`already_completed` の判別 union で返す。
   - `weekly-review-use-cases.ts`: create/get/list/update。作成は `profileRepository.ensure` で timezone・`weekStartsOn` を得て今日を求め、週を検証し、既存があれば返す。なければ習慣・記録・チェックインを取得して Domain でスナップショットを作り `createIfAbsent`。保存済み `summary_json` は contracts の schema で検証し、不一致は内部エラー。
   - `weekly-review-cursor.ts`: 一覧の cursor(`weekStart` のみ。改ざんされても actor 条件付きで解決)。
   - errors: `ReviewWeekNotAllowedError`(reason)、`WeeklyReviewNotFoundError`、`WeeklyReviewAlreadyCompletedError`、`InvalidWeeklyReviewCursorError`。
3. **Infrastructure**(`packages/infrastructure/src/tracking/`): `PrismaWeeklyReviewRepository`(作成は `INSERT ... ON CONFLICT (user_id, week_start) DO NOTHING RETURNING`、更新は `UPDATE ... WHERE public_id AND user_id AND status = 'draft'` の単一文、失敗時は存在確認で not_found/already_completed を判別)。`PrismaDailyCheckInRepository.listByDateRange`。
4. **Migration**: `20261005000000_t301_weekly_review_constraints`(CHECK 4 つ)。
5. **Contracts**(`packages/contracts/src/weekly-review.ts`): request/query/response と `weeklyReviewSummarySchema`。
6. **Presentation**(`apps/web`): `weekly-review-handlers.ts`、`weekly-review-container.ts`、`app/api/v1/weekly-reviews/route.ts`(GET/POST)、`app/api/v1/weekly-reviews/[reviewId]/route.ts`(GET/PATCH)。
7. **文書**: `docs/04`(実装時の補足)、`docs/05`(契約差分)、`docs/09`、`docs/10`(D-14、P1 解消)。

## Impact Analysis

| Area           | Change                                                                                     | Risk                                            |
| -------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Domain         | `statistics.ts` の分類を関数へ切り出し(挙動不変)、`weekly-review.ts` を追加                | 低(既存の statistics テストで回帰を検知)        |
| Application    | check-in port に 1 メソッド追加(fake も更新)、weekly review の port/use case/cursor を追加 | 低                                              |
| Infrastructure | 新 repository 1 件、check-in の `findMany` 追加                                            | 中(原子的な更新・並行作成を Integration で検証) |
| Presentation   | 新規 route 2 件と handler                                                                  | 低                                              |
| Database       | CHECK 制約 4 件の追加(expand)                                                              | 低(既存行なし前提。fresh/upgrade で検証)        |
| API/Event      | 新規 endpoint 4 件                                                                         | 低                                              |
| AWS/Terraform  | 変更なし                                                                                   | N/A                                             |
| Observability  | 変更なし                                                                                   | N/A                                             |

## Interfaces and Contracts

- Domain: `outcomeOf`(内部)、`calculateRangeStatistics`、`weekEndOf`、`buildWeeklyReviewSummary(input): WeeklyReviewSummary`、`normalizeWeeklyReflection(value): string | null`、`REVIEW_MAX_WEEKS_BACK`。
- Application:
  - `WeeklyReviewRepositoryPort`(すべて `actorUserId` 必須)。
  - `createWeeklyReviewUseCase(deps, { actorUserId, weekStart }): Promise<{ review, created }>`、`getWeeklyReviewUseCase`、`listWeeklyReviewsUseCase(deps, { actorUserId, limit, cursor }): Promise<{ items, nextCursor }>`、`updateWeeklyReviewUseCase(deps, { actorUserId, reviewId, reflection?, complete })`。
  - `DailyCheckInRepositoryPort.listByDateRange({ actorUserId, from, to })`。
- Contracts / HTTP: Spec の API and Events 節のとおり。

## Data Migration

- Expand: CHECK 制約 4 件を追加(`completed_at` 整合、`reflection` 長、`timezone_snapshot` 長、`summary_json` が object)。
- Backfill/Switch/Contract: N/A(`weekly_reviews` は T-301 以前にアプリが書き込んでおらず既存行がない前提。適用前に行数を確認する)。
- Rollback/forward fix: 制約を drop する forward migration、またはアプリの revert。データ損失なし。
- 検証: fresh DB と、直前 migration までの既存 schema からの upgrade の両方(`schema.integration.test.ts` の既存方式に倣う)。

## Security Review

- Authentication/authorization: session から actor を取得し、repository の全 query に actor user ID と(単体操作では)`public_id` を渡す。他人のレビューは 404。
- PII/secrets/logging: 習慣名・`reflection`・集計値をログに出さない。応答は `id`/`kind`/`name` のみで習慣の `purpose`/`cue` やチェックインのメモを含めない。fixture は架空データのみ。AI/外部送信なし。
- CSRF/Content-Type/size: POST/PATCH は Origin 検証、`application/json`、body 上限、未知キー拒否。
- Abuse controls: 1 週 1 件、最大 52 週、reflection 1000 文字。Rate limit は Accepted Risk。
- SQL: `$queryRaw` はタグ付きテンプレートのみ(バインド変数)。JSON は `jsonb` へ型付きで渡す。

## Test Plan

| Requirement  | Test level  | Planned test                                                                                                                                                                      |
| ------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STAT 回帰    | Unit        | 既存 `statistics.test.ts` が全件通ること(分類の切り出しで挙動が変わらない)                                                                                                        |
| WREV-003     | Unit        | `weekly-review.test.ts`: 分類・skipped・予定外の記録の無視・版切替・習慣なし・予定がない習慣の除外・チェックイン平均、性質テスト(件数恒等式、overall = habits の合計、習慣の順序) |
| WREV-005     | Unit        | `normalizeWeeklyReflection`: trim/空→null/1000・1001 境界/サロゲートペア/制御文字、性質テスト(冪等: normalize(normalize(x)) = normalize(x))                                       |
| WREV-001/002 | Unit        | `weekly-review.test.ts`(application): 週の開始日/進行中/未来/52 週境界/Asia/Tokyo 繰り上がり/日曜始まり、既存は再計算しない、user 不存在、actor が repo に渡る                    |
| WREV-004     | Unit        | get/list/cursor(改ざん・不正値)、newest first、他人の ID は not_found                                                                                                             |
| WREV-005     | Unit        | update: draft 更新、省略は不変、確定、completed は already_completed、not_found                                                                                                   |
| 契約         | Unit        | `contracts/weekly-review.test.ts`: request(未知キー、空 body、境界、制御文字)、query、summary schema の拒否                                                                       |
| HTTP         | Unit        | `weekly-review-handlers.test.ts`: 201/200/401/403/404/409/413/415/422 のマッピング、内部 ID 非含有、no-store                                                                      |
| WREV-001/INV | Integration | 作成の往復、再作成で snapshot 不変、並行作成 6 件で 1 行・`created` が 1 件、他ユーザー分離                                                                                       |
| WREV-004/005 | Integration | 一覧の並び・ページング、更新・確定の往復、completed の不変、並行確定 6 件で 1 回のみ成功、CHECK 制約、fresh/upgrade の Migration                                                  |
| WREV-003     | Integration | 実 DB の記録・チェックインから `createWeeklyReviewUseCase` の summary 全体を検証(習慣 2 件・チェックイン)、`listByDateRange`(check-in)の境界・分離                                |

テスト品質の 3 観点(プロパティベース/変異確認/敵対的審査)を実施し、結果を完了報告に記す。

## Rollout and Operations

- Feature Flag: 不要(新規 route のみ)。
- Deployment order: Migration(CHECK 追加。後方互換)→ アプリ。
- Metrics/alarms: 追加なし。
- Rollback trigger and procedure: 不具合時はアプリを revert する(制約は残して問題ない)。

## Task Breakdown

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Domain: `statistics.ts` の切り出し、`weekly-review.ts` + Unit Test
3. Contracts: schema + Unit Test
4. Application: check-in port 追加、weekly review port/use case/cursor/errors、fake、Unit Test
5. Migration + Infrastructure: repository、check-in の範囲取得、Integration Test
6. Presentation: handler、container、route + Unit Test
7. 文書更新(`docs/04`、`05`、`09`、`10`)
8. 品質コマンド一式(`test:integration` を含む)の実行、セルフレビュー

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## Dependencies

- 先行 task: T-201(`generateOccurrences`、`weekStartOf`)、T-102(プロフィールの `weekStartsOn`/timezone)、T-202(記録、`listAllActiveHabits`)、T-203(チェックイン)、T-204(統計の分類)。いずれも main に merge 済み。
- ADR 依存、外部権限、provider: なし。

## Risks

| Risk                                              | Mitigation                                                                                | Owner |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- |
| 分類の切り出しで T-204 の挙動が変わる             | 既存 `statistics.test.ts`/`dashboard.test.ts` を変更せず通す。分類は 1 関数に集約         | TBD   |
| 並行する作成・確定で不整合                        | DB の unique 制約と単一文の原子的更新に依存し、並行 6 件の Integration Test で確認        | TBD   |
| 保存済み summary の schema 進化                   | `schemaVersion` を持たせ、読み出し時に検証。変更時は新 version を追加(過去は書き換えない) | TBD   |
| `weekStartsOn` 変更後に過去のレビューと週が重なる | Accepted Risk として Spec に明記。再計算しない                                            | TBD   |

## Start Conditions

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(該当ADRなし)
- [x] API/event契約がレビュー済み、またはN/A(Spec の API and Events 節)
- [x] Migration方針がレビュー済み、またはN/A(Spec の Data and Migration 節)
- [x] 認可・データ保護方針がレビュー済み(Security and Privacy 節)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、既存 fake)
- [x] 依存taskが完了している(T-201〜T-204 は main に merge 済み)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
