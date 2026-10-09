# Weekly Review Spec

Status: Ready
Owner: TBD
Last updated: 2026-10-06
Change classification: Standard
Roadmap Task: T-301

## Goal

ログイン済みのユーザーが、終了した週の習慣の実行結果を「集計スナップショット」として保存し、自分の振り返りを書いて確定できるようにする(UC-12)。週の終わりに 5〜10 分で「その週に何が起きたか」を見直せる状態を作り、後続の週次改善コーチング(T-303/T-305)の入力(集計と振り返り)の土台になる。

## Success Metrics

- 同じ週のレビュー作成を何度・並行して呼んでも、レビューは 1 件のまま、スナップショットは最初に作成した内容から変わらない(Integration Test で並行 6 件を確認)。
- 集計の定義(成功・未実施・スキップ・成功率)が T-204 の Domain 関数と同じ分類規則を共有し、Application/Infrastructure/Presentation で再実装していない。
- 週の境界が、プロフィールの `weekStartsOn`(既定は月曜)と timezone のローカル日で決まり、週の開始日以外・終了していない週・古すぎる週を作成できない(Unit Test)。
- 確定後のレビューは変更できない(並行する確定・更新でも 1 回だけ成功し、残りは 409)。
- 他ユーザーのレビューは存在を区別できない(404)。

## Scope

- Domain(tracking): `weekEndOf`、`buildWeeklyReviewSummary`(スナップショット生成)、`normalizeWeeklyReflection`。T-204 の `statistics.ts` から結果分類を共有する(`outcomeOf`、`calculateRangeStatistics`)。
- Application: `createWeeklyReviewUseCase`、`getWeeklyReviewUseCase`、`listWeeklyReviewsUseCase`、`updateWeeklyReviewUseCase`、`WeeklyReviewRepositoryPort`、`DailyCheckInRepositoryPort.listByDateRange`(週の集計用)。
- Infrastructure: `PrismaWeeklyReviewRepository`、`PrismaDailyCheckInRepository.listByDateRange`。
- Migration: `weekly_reviews` の CHECK 制約の追加のみ(expand)。
- Contracts: request/response の runtime schema(zod)。
- Presentation(`apps/web`): `GET/POST /api/v1/weekly-reviews`、`GET/PATCH /api/v1/weekly-reviews/{reviewId}`。
- 文書: `docs/04`、`docs/05`、`docs/09`、`docs/10`(D-14、P1 の一部を解消)。

## Out of Scope

- UI 画面と Playwright E2E(画面基盤・E2E 基盤が未導入。T-203/T-204 と同じ)。
- AI 分析(`POST /weekly-reviews/{id}/analysis`、`ai_jobs`、coaching suggestions)。T-303/T-305。
- 確定後の振り返り・スナップショットの編集、確定の取り消し。
- レビューの削除(アカウント削除は T-404 の cascade)。
- 週次の自動作成・リマインド通知(T-402)。
- アーカイブ済み習慣の集計、過去週の時点で active だった習慣の再現(作成時点の active 習慣で集計する。Accepted Risks)。
- 成果・障壁・自由記述への入力項目の分割(振り返りは 1 つの自由記述。AI 入力 `WeeklyImprovementInputV1.reflection` と同じ形)。
- Rate limit、構造化ログ。

## Actors and Preconditions

| Actor                  | Preconditions                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Guest(未認証)          | なし。`401`                                                                                     |
| Member(email 確認済み) | T-101 の session を持つ。timezone/週の開始曜日は T-102 のプロフィール(未作成なら既定で遅延作成) |

actor の user ID は session のみから取得し、request の body/query/path/header から受け取らない。

## Functional Requirements

### WREV-001 週次レビューの作成(冪等)

- `POST /api/v1/weekly-reviews` は body `{ "weekStart": "YYYY-MM-DD" }` で、対象週のレビューを `draft` として作成し、スナップショットを保存して `201` を返す。
- 同じ週のレビューが既にある場合は、新規作成も再計算もせず、既存のレビューを `200` で返す(スナップショットは作成時のまま変わらない。状態が `completed` でも同様)。
- 並行して同じ週を作成しても、レビューは 1 件のみで、全ての呼び出しが同じレビューを返す(`201` は実際に作成した 1 件のみ)。

### WREV-002 対象週の検証

- `weekStart` は、actor のプロフィールの `weekStartsOn` に一致する曜日の実在する暦日であること(週の開始日)。そうでなければ `422`。
- 週の最終日(`weekStart + 6 日`)が actor の「今日」より前であること(終了した週のみ)。そうでなければ `422`(進行中・未来の週は作成不可)。
- `weekStart` が「今日を含む週の開始日」から 52 週より前(`REVIEW_MAX_WEEKS_BACK = 52`)の場合は `422`。
- 3 つの違反は同じ code `week_not_reviewable` で、`fieldErrors.weekStart` のメッセージで区別する。

### WREV-003 スナップショット(`summary`)

作成時に 1 回だけ計算して保存する。`schemaVersion: 1`。

- `weekStart`/`weekEnd`(両端を含むローカル暦日)。
- `overall`: active な全習慣の合算。`scheduled`/`success`/`missed`/`skipped`/`pending` と `successRate`(`success / (success + missed)`、分母 0 は `null`。T-204 STAT-003/005 と同じ定義)。
- `habits`: 週内に予定機会が 1 件以上ある active 習慣ごとに、`habitId`/`kind`/`name` と上記の件数・成功率。習慣の作成が古い順。
- `checkIn`: 週内のデイリーチェックイン(T-203)の `days`(件数。0〜7)、`averageMood`/`averageDifficulty`(値のある日の平均。1 件もなければ `null`)。
- 週は終了済みのため `pending` は常に 0 になるが、結果分類は T-204 と同じ関数を使う(記録がない予定機会は `missed`)。
- 予定のない日の記録は無視する。習慣の版切替は T-201 の `generateOccurrences` に従う。
- 習慣の `purpose`/`cue` 等の自由記述、チェックインのメモは含めない。

### WREV-004 取得と一覧

- `GET /api/v1/weekly-reviews/{reviewId}` は自分のレビューを `200` で返す。存在しない・他人のレビュー・UUID 形式でない ID は区別せず `404 weekly_review_not_found`。
- `GET /api/v1/weekly-reviews` は自分のレビューを `weekStart` の新しい順で返す。query: `limit`(1〜50、既定 20)、`cursor`(不透明文字列)。応答は `{ items, nextCursor }`。不正な `cursor`・`limit` は `422`。

### WREV-005 振り返りの更新と確定

- `PATCH /api/v1/weekly-reviews/{reviewId}` の body は `{ "reflection"?: string | null, "status"?: "completed" }`。少なくとも 1 項目が必要(空 body は `422`)。未知キーは拒否する。
- `reflection` は前後の空白を除去し、空文字は `null` として保存する(クリア)。省略した場合は変更しない。最大 1000 文字(`WEEKLY_REVIEW_REFLECTION_MAX_LENGTH`。AI 入力の自由記述上限と同じ。契約 schema が受け取った文字列の長さを、Domain が空白除去後の長さを検査する)。改行・タブ以外の制御文字は不可。
- `status: "completed"` を指定すると、`reflection` の更新(同時に指定された場合)と確定を 1 回の原子的な更新で行い、`completedAt` を設定する。`status` に指定できる値は `completed` のみ。
- `draft` の間は何度でも `reflection` を更新できる。`completed` のレビューへの PATCH は内容に関わらず `409 weekly_review_already_completed`。

## Business Rules and Invariants

- WREV-INV-001(所有者限定): すべての repository 操作は actor user ID を条件に含む。他ユーザーのレビュー・記録は取得・更新されない。
- WREV-INV-002(一意性): `(user_id, week_start)` は 1 件(DB の unique 制約)。作成は `INSERT ... ON CONFLICT DO NOTHING` の単一文で行い、並行しても制約違反を表に出さない。
- WREV-INV-003(日付の基準): 「今日」・週の終了判定は actor の timezone と注入された Clock から決める。`now()` は 1 リクエストで 1 回だけ呼ぶ。
- WREV-INV-004(スナップショットの不変): `summary_json` は作成後に更新しない。確定後は `reflection`/`status`/`completed_at` も更新しない。
- WREV-INV-005(状態遷移の原子性): 確定・更新は `WHERE status = 'draft'` 付きの単一 `UPDATE` で行い、並行する確定・更新が `completed` を上書きしない。
- WREV-INV-006(整合): `status = 'completed'` と `completed_at IS NOT NULL` は常に同値(DB CHECK でも強制)。
- WREV-INV-007(定義の一元化): 結果分類・成功率は Domain の関数だけが持つ(T-204 と共有)。

## State Transitions

| From        | Action                                      | To          | 備考                          |
| ----------- | ------------------------------------------- | ----------- | ----------------------------- |
| (なし)      | POST(終了済みの週)                          | `draft`     | スナップショット保存          |
| `draft`     | PATCH `reflection` のみ                     | `draft`     | 何度でも可                    |
| `draft`     | PATCH `status: "completed"`(+ `reflection`) | `completed` | `completed_at` 設定。取消不可 |
| `completed` | PATCH(任意)                                 | -           | `409`                         |

## Acceptance Criteria

```gherkin
Scenario: 終了した週のレビューを作成する
  Given timezone が Asia/Tokyo、weekStartsOn が 1(月曜)、今日が 2026-01-14(水)
  And 2026-01-05(月)〜2026-01-11(日)に、毎日予定の習慣で success 4、skipped 1、記録なし 2
  When POST /weekly-reviews { weekStart: "2026-01-05" }
  Then 201 で status は draft、summary.overall は scheduled=7, success=4, skipped=1, missed=2, pending=0, successRate=4/6

Scenario: 同じ週の再作成は既存を返す
  Given 2026-01-05 週のレビューが作成済みで、その後に週内の記録を訂正した
  When 同じ weekStart で POST する
  Then 200 で、summary は最初の作成時のまま(記録の訂正を反映しない)

Scenario: 週の開始日でない日付は拒否する
  Given weekStartsOn が 1
  When weekStart "2026-01-06"(火)で POST する
  Then 422 week_not_reviewable

Scenario: 進行中の週・未来の週は作成できない
  Given 今日が 2026-01-14(水)
  When weekStart "2026-01-12"(今週の月曜)で POST する
  Then 422 week_not_reviewable

Scenario: 週の最終日が今日より前になった翌日から作成できる
  Given timezone が Asia/Tokyo、Clock が 2026-01-11T14:59:59Z(Tokyo では 2026-01-11 23:59:59)
  Then weekStart "2026-01-05" は 422
  Given Clock が 2026-01-11T15:00:00Z(Tokyo では 2026-01-12)
  Then weekStart "2026-01-05" は 201

Scenario: 古すぎる週は作成できない
  Given 今日を含む週の開始日が 2026-01-12
  Then weekStart "2025-01-13"(52 週前)は 201、"2025-01-06"(53 週前)は 422

Scenario: 週内に予定のない習慣はスナップショットに含めない
  Given 習慣 A は週内に予定があり、習慣 B は週の途中より後に作成された(週内に予定機会がない)
  Then summary.habits には A のみが含まれる

Scenario: チェックインの集計
  Given 週内に mood が 4 と 2 の 2 日分、difficulty が 3 の 1 日分のチェックインがある
  Then summary.checkIn は days=2, averageMood=3, averageDifficulty=3

Scenario: 振り返りを更新して確定する
  Given draft のレビュー
  When PATCH { reflection: "  よく続いた  " } する
  Then 200 で reflection は "よく続いた"、status は draft
  When PATCH { status: "completed" } する
  Then 200 で status は completed、completedAt が設定される

Scenario: 確定後は変更できない
  Given completed のレビュー
  When PATCH { reflection: "追記" } する
  Then 409 weekly_review_already_completed、reflection は変わらない

Scenario: 並行した確定は 1 回だけ成功する
  Given draft のレビュー
  When { status: "completed" } を並行して 6 回 PATCH する
  Then 1 回だけ 200、残りは 409

Scenario: 他ユーザーのレビュー
  Given ユーザー A のレビュー
  When ユーザー B が GET または PATCH する
  Then どちらも 404 weekly_review_not_found(存在を区別できない)

Scenario: 一覧のページング
  Given レビューが 3 件
  When limit=2 で GET する
  Then weekStart の新しい順に 2 件と nextCursor が返り、nextCursor で残り 1 件が返り nextCursor は null
```

## Authorization Matrix

| Operation                  | Guest | Member(自分の) |         Member(他人の) |
| -------------------------- | ----: | -------------: | ---------------------: |
| POST /weekly-reviews       |   401 |            Yes | 到達不可(自分の分のみ) |
| GET /weekly-reviews        |   401 |            Yes | 到達不可(自分の分のみ) |
| GET /weekly-reviews/{id}   |   401 |            Yes |                    404 |
| PATCH /weekly-reviews/{id} |   401 |            Yes |                    404 |

IDOR/BOLA: `reviewId` は外部公開 ID(UUID。内部 PK を公開しない)で、repository が `public_id` と `user_id` の両方で解決する。Admin は対象外(T-403)。

## API and Events

共通: base path `/api/v1`、JSON、Problem Details、`Cache-Control: no-store`。状態変更メソッド(POST/PATCH)は Origin 検証(CSRF)、Content-Type `application/json`(415)、body 上限(413)、未知キー拒否(422)。Events は発行しない。

| Method/Path                        | 入力                            | 成功    | エラー                                         |
| ---------------------------------- | ------------------------------- | ------- | ---------------------------------------------- |
| `GET /weekly-reviews`              | query `limit`、`cursor`         | 200     | 401, 422                                       |
| `POST /weekly-reviews`             | body `{ weekStart }`            | 201/200 | 401, 403, 404(`user_not_found`), 413, 415, 422 |
| `GET /weekly-reviews/{reviewId}`   | path                            | 200     | 401, 404                                       |
| `PATCH /weekly-reviews/{reviewId}` | body `{ reflection?, status? }` | 200     | 401, 403, 404, 409, 413, 415, 422              |

エラー code: `week_not_reviewable`(422)、`invalid_cursor`(422)、`weekly_review_not_found`(404)、`weekly_review_already_completed`(409)、`user_not_found`(404)、`validation_failed`(422)。

### Resource: WeeklyReview

```json
{
  "id": "<uuid>",
  "weekStart": "2026-01-05",
  "weekEnd": "2026-01-11",
  "timezone": "Asia/Tokyo",
  "status": "draft",
  "summary": {
    "schemaVersion": 1,
    "weekStart": "2026-01-05",
    "weekEnd": "2026-01-11",
    "overall": {
      "scheduled": 7,
      "success": 4,
      "missed": 2,
      "skipped": 1,
      "pending": 0,
      "successRate": 0.6666666666666666
    },
    "habits": [
      {
        "habitId": "<uuid>",
        "kind": "build",
        "name": "水を飲む",
        "scheduled": 7,
        "success": 4,
        "missed": 2,
        "skipped": 1,
        "pending": 0,
        "successRate": 0.6666666666666666
      }
    ],
    "checkIn": { "days": 2, "averageMood": 3, "averageDifficulty": 3 }
  },
  "reflection": null,
  "completedAt": null,
  "createdAt": "2026-01-14T00:00:00.000Z",
  "updatedAt": "2026-01-14T00:00:00.000Z"
}
```

- 一覧の `items` も同じ形。内部 PK、`user_id` は含めない。`timezone` は作成時の `timezone_snapshot`。

## Data and Migration

- 既存の `weekly_reviews`(`public_id` UNIQUE、`UNIQUE(user_id, week_start)`、`status` CHECK、`set_updated_at` trigger、FK `ON DELETE CASCADE`)を使う。一覧のアクセスパターン(`WHERE user_id = ? ORDER BY week_start DESC`)は既存の `(user_id, week_start)` unique index に一致する。
- Migration(expand、後方互換。`weekly_reviews` は T-301 以前にアプリが書き込んでおらず既存行がない前提のため backfill 不要):
  - `weekly_reviews_completed_at_check`: `(status = 'completed') = (completed_at IS NOT NULL)`。
  - `weekly_reviews_reflection_length_check`: `reflection IS NULL OR char_length(reflection) BETWEEN 1 AND 1000`。
  - `weekly_reviews_timezone_check`: `char_length(timezone_snapshot) BETWEEN 1 AND 64`。
  - `weekly_reviews_summary_object_check`: `jsonb_typeof(summary_json) = 'object'`。
- 記録・チェックインの取得は週 7 日分の範囲取得 1 回ずつ(習慣数に依らない)。
- rollback: CHECK を drop する forward fix、またはアプリの revert。データ損失なし。

## Failure and Edge Cases

- session の user が存在しない → 404 `user_not_found`(作成時)。
- 並行作成の敗者: `ON CONFLICT DO NOTHING` で 0 行になった場合は既存レビューを取得して返す(`created = false`)。取得できない(直後に削除された等)場合は内部エラー(500)。
- 習慣が 0 件、または週内に記録・チェックインが 0 件 → 作成できる。`overall` は件数 0・`successRate` は `null`、`habits` は空配列、`checkIn.days` は 0。
- timezone/weekStartsOn を変更した後: 既存レビューは変更しない。新しい設定で週の開始日が合わない `weekStart` は 422。旧設定と新設定の週が重なるレビューが存在しうる(Accepted Risks)。
- 保存済みの `summary_json` が `schemaVersion: 1` のスキーマに合わない(データ破損)→ 内部エラー(500)。内部詳細は応答に含めない。
- `reflection` の前後空白のみ → `null`(クリア)。受け取った文字列が 1000 文字ちょうどは可、1001 文字は 422(契約 schema。前後に空白があっても受信時の長さで判定する)。

## Security and Privacy

- Data collected: 集計値(習慣名を含む)と振り返りの自由記述を本人にのみ返すために保存する。外部 provider(AI を含む)へは送信しない(AI 連携は T-303/T-305 で別 Spec)。保持・export・削除は `user_id` の `ON DELETE CASCADE` に従う(T-404)。
- Data forbidden in logs: 習慣名、`reflection`、集計値、session、cookie、email。route に独自ログを追加しない。
- IDOR/BOLA: WREV-INV-001。`reviewId` は UUID。CSRF: POST/PATCH は Origin 検証、GET は状態を変更しない。XSS: JSON のみ(表示時エスケープは UI の責務)。Injection: Prisma の型付き query と `$queryRaw` タグ付きテンプレート(バインド変数のみ、文字列連結なし)。
- Abuse: 作成は 1 ユーザー 1 週 1 件で、対象週は最大 52 週まで。1 週の取得量は習慣数 × 7 件と 7 件のチェックイン。reflection は 1000 文字、body は上限付き。Rate limit は Out of Scope(Accepted Risks)。
- 一覧・取得応答に `reflection` を含めるため `no-store` とする。

## AI Requirements

N/A。本 Spec は AI を利用しない。スナップショットと `reflection` は将来の `WeeklyImprovementInputV1`(T-302)の入力元になるが、AI へ送る際の最小化・匿名化は T-303/T-305 の Spec で定める。

## Observability and Operations

- Logs: route に独自ログを追加しない(構造化ログ基盤が未導入)。
- Metrics/Alerts: 既存方針(`docs/06`)の request count/error/latency に含まれる。「週次レビュー完了率」の指標化は分析基盤の導入時に `status`/`completed_at` から算出できる。
- Runbook: 不要。Feature Flag なし(新規 route のみ)。rollback はアプリの revert(CHECK 制約は残しても無害)。

## Test Coverage Matrix

| Requirement  | Unit                                                                                                                                      | Integration(実 PostgreSQL)                                                               | E2E                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| WREV-001     | `createWeeklyReviewUseCase`(新規 201 相当/既存 200 相当、既存は再計算しない、user 不存在)、handler の 201/200/401/403/415/422             | 作成の往復、再作成で snapshot 不変、並行 6 件で 1 行・`created` は 1 件のみ              | N/A(E2E 基盤導入後に追加) |
| WREV-002     | 週の開始日でない/進行中/未来/52 週境界/Asia/Tokyo の日付繰り上がり/weekStartsOn が日曜                                                    | -                                                                                        | N/A                       |
| WREV-003     | `buildWeeklyReviewSummary`(分類、skipped、予定外の記録の無視、版切替、習慣なし、チェックイン平均、週内に予定がない習慣の除外、性質テスト) | 実 DB の記録・チェックインから期待どおりの summary、他ユーザーの記録が混ざらない         | N/A                       |
| WREV-004     | get/list(404、cursor、limit、newest first、他人分が出ない)、cursor の encode/decode                                                       | 一覧の並び・ページング・他ユーザー分離、`public_id` 解決                                 | N/A                       |
| WREV-005     | `normalizeWeeklyReflection`(trim、空→null、1000/1001 境界、制御文字)、update(draft の更新、確定、completed は 409、reflection 省略は不変) | 確定の往復、`completed` の不変、並行確定 6 件で 1 回のみ成功、他人の review は not_found | N/A                       |
| WREV-INV-001 | repository 呼び出しに actor が渡る(fake)                                                                                                  | 他ユーザーの review を get/update できない                                               | N/A                       |
| WREV-INV-006 | -                                                                                                                                         | CHECK 制約(completed と completed_at の不整合、reflection 長、summary が object)         | N/A                       |
| Migration    | -                                                                                                                                         | fresh DB と既存 schema(直前 migration まで)からの upgrade の両方                         | N/A                       |
| 契約         | request/response schema(未知キー、境界、null、日付形式)、問題がある `summary` の拒否                                                      | -                                                                                        | N/A                       |

テスト品質の 3 観点: 集計・正規化・状態遷移の不変条件はシード固定の性質テスト、実装を意図的に壊す変異確認(手動。Stryker 未導入)、敵対的審査(境界・並行・他人 ID・改ざん cursor)を実施し、結果を完了報告に記す。

Fake/Stub 方針: Application の unit test は in-memory fake と固定 Clock、既存の habit/profile/check-in/entry fake。Integration は Testcontainers の実 PostgreSQL。fixture は架空データのみ。

## Open Questions

実装をブロックしない事項:

- **成果・障壁・自由記述の分割入力**: UI/T-305 で必要になった時点で別 Spec とする(その場合は `reflection` の構造化を expand/contract で行う)。
- **週次レビューの作成を促す導線**(通知・UI のタイミング): T-402/UI タスクで扱う。
- **確定後の編集の要否**: 利用実績を見て判断(`docs/10` の検証すべき仮説)。
- **`weekStartsOn` 変更後の過去レビューの扱い**: 本 Spec は変更しない(再計算しない)。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-10-06
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                            |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope。`docs/02` UC-12、`docs/09` T-301                                                         |
| Specification        | Pass   | WREV-001〜005、WREV-INV-001〜007、State Transitions、Acceptance Criteria、Failure and Edge Cases。未決事項は非ブロック(D-14 で決定) |
| Domain and Time      | Pass   | 週境界は `weekStartOf`/`localDateAt`(プロフィールの timezone と `weekStartsOn`)、Clock 注入、日付繰り上がり・52 週境界を明記        |
| API and Data         | Pass   | API and Events(エラー code、冪等、pagination、競合)、Data and Migration(expand、index、取得量、rollback)                            |
| Security and Privacy | Pass   | Security and Privacy、Authorization Matrix(IDOR/CSRF/XSS/Injection/abuse、ログ禁止、AI へ送らない)                                  |
| AI                   | N/A    | AI を利用しない(T-303/T-305 で別 Spec)                                                                                              |
| Testing              | Pass   | Test Coverage Matrix。E2E は基盤未導入のため N/A と理由を明記                                                                       |
| Operations           | Pass   | Observability and Operations(ログ方針、rollout/rollback)                                                                            |
| Planning             | Pass   | [../plans/weekly-review.md](../plans/weekly-review.md)                                                                              |

### Accepted Risks

- Rate limit 未実装(T-104/T-202〜T-204 と同じ)。作成件数は 1 週 1 件・最大 52 週で頭打ち。
- スナップショットは作成時点の active 習慣で集計する。作成後にアーカイブ・編集された習慣、過去週の時点で active だったがその後アーカイブされた習慣は反映されない。
- `weekStartsOn` を変更すると、旧設定の週と新設定の週が重なるレビューが共存しうる(`UNIQUE(user_id, week_start)` は開始日のみ)。
- 確定後は編集できない。誤った確定の訂正手段はない(UI で確定前の確認を求める前提)。
- 構造化ログ未導入のため、本 API 固有の運用ログ/metric は追加しない。
