# Statistics Dashboard Spec

Status: Ready
Owner: TBD
Last updated: 2026-10-04
Change classification: Standard
Roadmap Task: T-204

## Goal

ログイン済みのユーザーが、習慣ごとのストリークと直近 7/30 日の成功率、全習慣を合算した成功率を 1 回の取得で確認できるようにする(UC-11)。記録(T-202)が貯まった結果を「続けられている」実感に変え、週次レビュー(T-301)の集計の土台になる。

## Success Metrics

- `GET /api/v1/dashboard` が、習慣の数に関わらず一定回数の DB アクセス(プロフィール 1、active 習慣の一覧、記録の範囲取得 1)で応答する(Unit/Integration Test で確認)。
- ストリーク・成功率の定義を Domain の純粋関数だけが持ち、Application/Presentation/Infrastructure で再実装していない(`docs/04` 集計定義のとおり)。
- 「今日」と各期間の境界が、ユーザーの timezone のローカル日(T-201 の `localDateAt`)で決まり、DST 日・日付境界・習慣の版切替を Unit Test で確認している。
- 他ユーザーの習慣・記録が集計に混ざらない(actor は session のみ)。
- 記録が 1 件もない新規ユーザーでも 200 を返し、成功率は `null`、ストリークは 0 になる(空状態)。

## Scope

- Domain(tracking): `calculateHabitStatistics`(1 習慣の予定機会ごとの結果、ストリーク、7/30 日の件数と成功率)、`aggregateWindowStatistics`(全体の合算)。
- Application: `getDashboardUseCase`、`HabitEntryRepositoryPort.listByDateRange`(actor の期間内の記録をすべて返す)。
- Infrastructure: `PrismaHabitEntryRepository.listByDateRange`。
- Contracts: response の runtime schema(zod)。
- Presentation(`apps/web`): `GET /api/v1/dashboard`。
- 文書: `docs/04`(実装時の補足)、`docs/05`(契約差分)、`docs/09`、`docs/10`(D-13)。

## Out of Scope

- UI 画面(apps/web に画面基盤がないため。API と集計ロジックまで)。Playwright E2E(基盤未導入。T-202/T-203 と同じ)。
- 任意期間の指定(`from`/`to`)。固定の 7/30 日とストリークのみ。必要になった時点で別 Spec で追加する(`docs/05` は本タスクで更新する)。
- アーカイブ済み習慣の集計、履歴一覧 `GET /habit-entries`、デイリーチェックインの集計(WAU を含む)、週次の集計(T-301)。
- 全習慣を通したストリーク(習慣ごとに予定が異なり意味を持たないため算出しない)。
- キャッシュ、集計テーブル、SQL 集計(計算は Domain の関数で行う。性能上必要になった時点で、同じ契約テストを通す前提で検討する)。
- Rate limit、構造化ログ。

## Actors and Preconditions

| Actor                  | Preconditions                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Guest(未認証)          | なし。`401`                                                                         |
| Member(email 確認済み) | T-101 の session を持つ。timezone は T-102 のプロフィール(未作成なら既定で遅延作成) |

actor の user ID は session のみから取得し、request の body/query/path/header から受け取らない。

## Functional Requirements

### STAT-001 ダッシュボードの取得

- `GET /api/v1/dashboard` は `200` と、actor の「今日」、timezone、全体の集計(`overall`)、active な習慣ごとの集計(`habits`)を返す。query は受け付けない(未知の query は無視する)。
- `habits` は習慣の作成が古い順。active な習慣がなければ空配列で、`overall` の件数は 0、成功率は `null`。

### STAT-002 予定機会ごとの結果

ある習慣の、対象期間内の各予定機会(T-201 の `generateOccurrences`。習慣の ScheduleVersion に従う)は、次のいずれか 1 つに分類される。

| 結果      | 条件                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------- |
| `success` | その日の記録の status が `success`                                                                |
| `missed`  | 記録の status が `missed`、または記録がなく日付が今日より前(未入力は期日経過後に未実施として扱う) |
| `skipped` | 記録の status が `skipped`                                                                        |
| `pending` | 記録がなく日付が今日(今日が終わるまでは確定しない)                                                |

- 予定のない日に記録があっても無視する(予定の変更で生じうる)。
- 成功判定そのもの(`build` の `quantity >= targetCount`)は記録時に確定済みで、集計は保存された status だけを見る。

### STAT-003 成功率

- 対象期間は「今日を含む直近 N 日」(`[today - (N-1), today]`)。N は 7 と 30。
- 件数: `scheduled`(期間内の予定機会数)、`success`、`missed`、`skipped`、`pending`。`scheduled = success + missed + skipped + pending`。
- `successRate = success / (success + missed)`。分母が 0 のときは `null`(`docs/04` の `success / (scheduled - skipped)` から、確定していない `pending` を除いたもの)。
- 習慣の最初の予定機会より前の日は予定機会がないため自然に対象外になる。

### STAT-004 ストリーク

- 対象は、今日までの直近 366 日(`STREAK_LOOKBACK_DAYS`。`MAX_OCCURRENCE_RANGE_DAYS` と同じ)の予定機会を古い順に並べたもの。
- `success` は連続数を 1 増やす。`missed` は 0 に戻す。`skipped` と `pending` は連続数を変えない(切らず、数えない)。非予定日は予定機会に含まれないため切断しない。
- `currentStreak` は末尾時点の連続数。`longestStreak` は対象期間内の連続数の最大値。いずれも最大 366 日分の予定機会までしか遡らない(それより長い連続は打ち切られる)。
- 予定機会がない、または success がない習慣は両方 0。

### STAT-005 全体の集計

- `overall.last7Days`/`last30Days` は、active な全習慣の件数(`scheduled`/`success`/`missed`/`skipped`/`pending`)の合計で、`successRate` は合計の `success / (success + missed)`(習慣ごとの率の平均ではない)。分母が 0 は `null`。

## Business Rules and Invariants

- STAT-INV-001(所有者限定): すべての repository 操作は actor user ID を条件に含む。他ユーザーの習慣・記録は取得されない。
- STAT-INV-002(日付の基準): 「今日」と各期間は actor のプロフィール timezone と注入された Clock から決める。`now()` は 1 リクエストで 1 回だけ呼ぶ(`resolveLocalToday`)。
- STAT-INV-003(定義の一元化): 集計定義は Domain の関数だけが持つ。SQL 集計を追加する場合も同じ契約テストを通す(`docs/04`)。
- STAT-INV-004(対象は active のみ): アーカイブ済み習慣は `habits`/`overall` のいずれにも含めない。
- STAT-INV-005(読み取り専用): 状態を変更しない。冪等で、副作用・イベントはない。

## State Transitions

なし(読み取り専用)。

## Acceptance Criteria

```gherkin
Scenario: 空状態
  Given active な習慣がない、または記録が 1 件もない
  When GET /dashboard を呼ぶ
  Then 200 で habits は空(または各習慣のストリーク 0)、successRate は null

Scenario: 成功率(今日の未記録は保留)
  Given 毎日予定の習慣で、今日(2026-01-14)を除く直近 6 日のうち 4 日が success、1 日が missed、1 日は記録なし
  And 今日は記録なし
  When GET /dashboard を呼ぶ
  Then last7Days は success=4, missed=2, skipped=0, pending=1, scheduled=7, successRate=4/6

Scenario: skip は分母から除外する
  Given 直近 7 日で success 3、skipped 2、missed 0(残りは予定なし)
  Then successRate は 1(3/3)

Scenario: 現在ストリーク(非予定日は切らない)
  Given 月・水・金が予定で、直近の予定機会が 月 success、水 success、金 success、(土日は予定なし)、今日の月 は記録なし
  Then currentStreak は 3(今日の未記録は保留、非予定日は切らない)

Scenario: missed でストリークが切れる
  Given 予定機会が 古い順に success, success, missed, success
  Then currentStreak は 1、longestStreak は 2

Scenario: skip はストリークを切らず数えない
  Given 予定機会が 古い順に success, skipped, success
  Then currentStreak は 2

Scenario: 今日が success ならストリークに含める
  Given 昨日まで 3 連続 success で、今日も success
  Then currentStreak は 4

Scenario: 版切替
  Given 水曜日が予定だった版から、版切替日以降は火曜日が予定の版へ変わった習慣
  Then 切替前は水曜日、切替後は火曜日の予定機会だけが集計される

Scenario: ローカル日で判定する
  Given timezone が Asia/Tokyo、Clock が 2026-01-13T20:00:00Z(Tokyo では 2026-01-14)
  Then date は 2026-01-14 で、7 日の期間は 2026-01-08〜2026-01-14

Scenario: 全体は合計から率を出す
  Given 習慣 A が success 1/missed 0、習慣 B が success 1/missed 2
  Then overall の successRate は 2/4(習慣ごとの率の平均 0.667 ではない)

Scenario: 他ユーザーの記録は見えない
  Given ユーザー A の習慣と記録
  When ユーザー B が GET /dashboard を呼ぶ
  Then B の応答に A の習慣・記録は含まれない

Scenario: アーカイブ済み習慣は含めない
  Given アーカイブした習慣
  Then habits と overall の件数に含まれない
```

## Authorization Matrix

| Operation      | Guest | Member(自分) |           Member(他人) |
| -------------- | ----: | -----------: | ---------------------: |
| GET /dashboard |   401 |          Yes | 到達不可(自分の分のみ) |

path/query にユーザーや習慣を含めないため IDOR の経路がない。Admin は対象外(T-403)。

## API and Events

共通: base path `/api/v1`、JSON、Problem Details、`Cache-Control: no-store`。状態を変更しないため Origin 検証・body 検証は不要。Events は発行しない。

| Method/Path      | 入力 | 成功 | エラー                     |
| ---------------- | ---- | ---- | -------------------------- |
| `GET /dashboard` | なし | 200  | 401, 404(`user_not_found`) |

### Resource: Dashboard

```json
{
  "date": "2026-01-14",
  "timezone": "Asia/Tokyo",
  "overall": {
    "last7Days": {
      "from": "2026-01-08",
      "to": "2026-01-14",
      "scheduled": 7,
      "success": 4,
      "missed": 2,
      "skipped": 0,
      "pending": 1,
      "successRate": 0.6666666666666666
    },
    "last30Days": {
      "from": "2025-12-16",
      "to": "2026-01-14",
      "scheduled": 30,
      "success": 20,
      "missed": 9,
      "skipped": 0,
      "pending": 1,
      "successRate": 0.6896551724137931
    }
  },
  "habits": [
    {
      "habit": { "id": "<uuid>", "kind": "build", "name": "水を飲む" },
      "currentStreak": 3,
      "longestStreak": 10,
      "last7Days": { "...": "overall と同じ形" },
      "last30Days": { "...": "overall と同じ形" }
    }
  ]
}
```

- `successRate` は 0〜1 の小数または `null`(表示の丸めは UI)。内部 PK、`user_id` は含めない。習慣の自由記述(`purpose`/`cue` 等)は含めず、識別に必要な `id`/`kind`/`name` のみ。

## Data and Migration

- Migration なし。既存の `habit_entries` を読むのみ。
- アクセスパターン: `WHERE user_id = ? AND habit_date BETWEEN ? AND ?` は既存 index `(user_id, habit_date DESC, id DESC)` に一致する。習慣の取得は T-202 と同じ `habitRepository.list`。
- 記録の取得量は最大「active 習慣数 × 366 件」。1 回の query で取得し、N+1 は起こさない。
- rollback: スキーマ変更なしのため、アプリの revert のみで戻せる。

## Failure and Edge Cases

- session の user が存在しない → 404 `user_not_found`。
- 習慣が作成直後で予定機会が期間内にない → 件数 0、successRate `null`、ストリーク 0。
- 全予定が skipped → 分母 0 で `successRate` は `null`。
- 今日だけが予定機会で未記録 → `pending=1`、successRate `null`、ストリーク 0。
- timezone 変更直後: 「今日」と期間は新 timezone で決まる。保存済みの `habit_date` は変更しない。
- 予定機会より前の日付の記録、予定のない日の記録 → 集計に含めない。
- 保存済みの status が不正(データ破損)→ 内部エラー(500)。内部詳細は応答に含めない。

## Security and Privacy

- Data collected: 新規の収集・保存なし。既存の記録と習慣名を集計して本人にのみ返す。外部 provider(AI を含む)への送信なし。
- Data forbidden in logs: 習慣名、記録、集計値、session、cookie、email。route に独自ログを追加しない。
- IDOR/BOLA: STAT-INV-001。CSRF: 状態を変更しない GET のため対象外(`Cache-Control: no-store`)。XSS: JSON のみ(習慣名の表示時エスケープは UI の責務)。Injection: Prisma の型付き query(バインド変数のみ)。
- Abuse: 取得量は習慣数 × 366 件で頭打ち。Rate limit は Out of Scope(Accepted Risks)。

## AI Requirements

N/A。AI を利用しない。

## Observability and Operations

- Logs: route に独自ログを追加しない(構造化ログ基盤が未導入)。
- Metrics/Alerts: 既存方針(`docs/06`)の request count/error/latency に含まれる。専用 metric/alarm は追加しない。
- Runbook: 不要。Feature Flag なし(新規 route のみ)。rollback はアプリの revert。

## Test Coverage Matrix

| Requirement  | Unit                                                                                                                  | Integration(実 PostgreSQL)                           | E2E                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| STAT-001     | `getDashboardUseCase`(fake: 習慣なし/あり、並び順、repository 呼び出し回数が習慣数に依らない)、handler の 200/401/404 | 習慣と記録を作り、use case 経由で応答全体を検証      | N/A(E2E 基盤導入後に追加) |
| STAT-002     | `calculateHabitStatistics`(success/missed/skipped/pending、予定外の記録の無視、版切替)                                | -                                                    | N/A                       |
| STAT-003     | 境界(分母 0、全 skipped、今日のみ予定)、7/30 日の期間境界、Asia/Tokyo の繰り上がり、DST 日                            | -                                                    | N/A                       |
| STAT-004     | 連続・missed で切断・skipped/pending は中立・非予定日・最長・366 日の打ち切り                                         | -                                                    | N/A                       |
| STAT-005     | `aggregateWindowStatistics`(合計から率、習慣ごとの率の平均ではない)                                                   | 複数習慣の合算                                       | N/A                       |
| STAT-INV-001 | repository 呼び出しに actor が渡ることを fake で検証                                                                  | `listByDateRange` が他ユーザーの記録を返さない       | N/A                       |
| STAT-INV-004 | アーカイブ済み習慣の記録が集計に混ざらない                                                                            | アーカイブした習慣が応答に出ない                     | N/A                       |
| 範囲取得     | -                                                                                                                     | `listByDateRange` の境界(両端含む)・並び・範囲外除外 | N/A                       |
| 契約         | response schema(`successRate` の null/0〜1、件数の整数)                                                               | -                                                    | N/A                       |

Fake/Stub 方針: Application の unit test は in-memory fake と固定 Clock、既存の habit/profile fake。Integration は Testcontainers の実 PostgreSQL。fixture は架空データのみ。Domain の性質テスト(予定機会の件数の恒等式)を含める。

## Open Questions

実装をブロックしない事項:

- **任意期間(`from`/`to`)の取得**: 必要になった時点で別 Spec 化する。
- **ストリークの表示方針**(強調しすぎない表示が復帰率を改善するか)は `docs/10` の検証すべき仮説。UI タスクで扱う。
- **未入力を UI で「未実施」と表示する確定タイミング**(`docs/10` P1): 本 Spec は「今日が終わるまで保留、翌日以降は未実施」(D-13)で集計する。UI の表示は別途。
- **Habit の `effectiveFrom` が作成日より過去の場合**、その間の未入力は `missed` として集計される。作成時に過去日を選べるかの方針は習慣作成側の Spec に従う。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-10-04
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                        |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope。`docs/02` UC-11、`docs/09` T-204                                                     |
| Specification        | Pass   | STAT-001〜005、STAT-INV-001〜005、Acceptance Criteria、Failure and Edge Cases。未決事項は非ブロック(D-13 で決定)                |
| Domain and Time      | Pass   | T-201 の `generateOccurrences`/`localDateAt` を使用、Clock 注入、timezone 変更・DST・日付境界・版切替を明記。読み取り専用で冪等 |
| API and Data         | Pass   | API and Events、Data and Migration(Migration なし、既存 index の確認、取得量の上限、rollback)                                   |
| Security and Privacy | Pass   | Security and Privacy、Authorization Matrix(IDOR/XSS/Injection/abuse、ログ禁止、AI へ送らない)                                   |
| AI                   | N/A    | AI を利用しない                                                                                                                 |
| Testing              | Pass   | Test Coverage Matrix。E2E は基盤未導入のため N/A と理由を明記                                                                   |
| Operations           | Pass   | Observability and Operations(ログ方針、rollout/rollback)                                                                        |
| Planning             | Pass   | [../plans/statistics-dashboard.md](../plans/statistics-dashboard.md)                                                            |

### Accepted Risks

- Rate limit 未実装(T-104/T-202/T-203 と同じ)。取得量の上限(習慣数 × 366 件)のみで抑える。
- 集計は毎回リクエスト時に計算する(キャッシュなし)。習慣数・記録数が増えて遅くなった場合は、同じ契約テストを通す前提で SQL 集計やキャッシュを検討する。
- ストリークは最大 366 日分で打ち切られる。
- 構造化ログ未導入のため、本 API 固有の運用ログ/metric は追加しない。
