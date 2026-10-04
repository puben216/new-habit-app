# Habit Repository, Use Cases and API Spec

Status: Ready
Owner: TBD
Last updated: 2026-10-02
Change classification: Standard
Roadmap Task: T-104

## Goal

ログイン済みのユーザーが、自分の習慣(`build`/`reduce`)を作成・一覧・取得・更新・アーカイブできるようにする。T-103 の Habit Domain を唯一の業務ルール定義として再利用し、永続化(repository)、認可(所有者のみ)、楽観ロック、cursor pagination、HTTP 契約(`/api/v1/habits`)を提供する。以降の tracking(T-201〜)が「自分の習慣」を安全に参照できる基盤になる。

## Success Metrics

- create/list/get/update/archive が実 PostgreSQL に対して Integration Test で green(constraint、IDOR、409、pagination を含む)。
- 他ユーザーの習慣は、取得・更新・アーカイブ・cursor のいずれの経路でも読み書きできず、常に 404 または cursor 無効として扱われる。
- 同一 `version` に対する並行更新は最大 1 件だけ成功し、残りは 409 になる(lost update が起きない)。
- 業務ルール(kind 不変、reduce の targetCount=1、daysOfWeek 値域、有効期間重複、有効開始日保持)を Application/Presentation/Infrastructure で再実装していない(Domain の公開関数のみを使用)。

## Scope

- Application: `createHabit`/`listHabits`/`getHabit`/`updateHabit`/`archiveHabit` の use case、`HabitRepositoryPort`、`IdGeneratorPort`、cursor の符号化/復号、Application error 型。
- Infrastructure: `PrismaHabitRepository`(`habits`/`habit_schedule_versions` の読み書き、transaction、楽観ロック、keyset pagination)、`IdGeneratorPort` の実装。
- Domain(追加のみ): DB 行からの復元用 `reconstituteHabit`(不変条件を再検証するだけで新しい業務ルールは持たない)。
- Contracts: request/response/query の runtime schema(zod、`.strict()`)。
- Presentation(`apps/web`): `GET/POST /api/v1/habits`、`GET/PATCH /api/v1/habits/{habitId}`、`POST /api/v1/habits/{habitId}/archive`。session からの actor 取得、Origin 検証、Problem Details へのエラー変換。
- DB schema の変更なし(Migration なし)。既存の `habits.version` 列、`habits_user_id_status_created_at_id_idx`、`habit_schedule_versions` の制約を使用する。

## Out of Scope

- `HabitEntry`(記録)、`GET /schedule/today` 等の tracking(T-201 以降)。
- `Idempotency-Key`(POST の二重送信対策)。`idempotency_keys` テーブルと共通処理は別タスクで扱う。二重送信時は習慣が重複作成されうる(Accepted Risks 参照)。
- Rate limit(具体的閾値が `docs/10` P2 で未決、かつ共通基盤が未実装)。
- `localTime`(リマインド用の実施予定時刻)。Domain の `ScheduleVersion` が `localTime` を持たず、用途は習慣ごとの通知であり、T-401 はユーザー単位の設定のみを扱うため、本タスクの API は受け付けない(未知キーとして 422)。DB 列 `habit_schedule_versions.local_time` は変更しない。
- 習慣の物理削除、ユーザー削除に伴う削除フロー(T-404)。
- Playwright E2E(本リポジトリは未導入。`AGENTS.md` の方針どおり導入後に追加する)。
- OpenAPI 文書の生成。本リポジトリには OpenAPI 生成基盤が未導入のため、runtime schema(`packages/contracts/src/habits.ts`)と本 Spec の API 節を契約の正本とする。生成基盤導入時にこの schema から導出する(ADR-009)。
- 習慣数の上限、`status` 以外の絞り込み・検索・並び替え。

## Actors and Preconditions

| Actor                  | Preconditions                                                        |
| ---------------------- | -------------------------------------------------------------------- |
| Guest(未認証)          | なし。すべての endpoint で `401`                                     |
| Member(email 確認済み) | T-101 の session を持つ(login は email 確認済みのみ許可されるため)。 |

actor の user ID は、T-101 の Auth.js `auth()`(session callback が付与する `session.user.id`、`users.id` の十進文字列)から取得する。この値以外(request body、query、header)から user ID を受け取らない。

## Functional Requirements

### HAPI-001 習慣の作成

- `POST /api/v1/habits` は kind、name、purpose、cue、minimumAction、replacementAction(任意)、schedule(`effectiveFrom`、`daysOfWeek`、`targetCount` 任意・既定 1)を受け取り、`201` と作成した習慣を返す。`Location` ヘッダは `/api/v1/habits/{id}`。
- 業務ルールの検証は Domain の `createHabit` に委ねる。`id`(外部 ID、UUID)は Application が `IdGeneratorPort` で採番して Domain へ渡し、初期 `version` は 1、`status` は `active`。
- `schedule.effectiveFrom` は必須とする(ユーザーのローカル日付は T-102 のプロフィール timezone に依存するため、サーバーが既定値を推測しない。クライアントがローカル日付を指定する)。`effectiveTo` は受け付けない(作成時は常に無期限)。

### HAPI-002 習慣の一覧

- `GET /api/v1/habits?status=active|archived&limit=&cursor=` は、actor 自身の習慣のみを `created_at desc, id desc` の順で返す。
- `status` の既定は `active`。`limit` は 1〜100、既定 20。応答は `{ items, nextCursor }`。続きがない場合 `nextCursor` は `null`。
- cursor は不透明な文字列(Application が生成)。cursor は発行時の `status` と結びつき、異なる `status` で使うと `422`。形式不正、存在しない/他ユーザーの習慣を指す cursor も `422`(`code: validation_failed`、`fieldErrors.cursor`)。
- ページ境界で重複・欠落が起きない(同一 `created_at` の習慣があっても `id` で決定的に並ぶ)。

### HAPI-003 習慣の取得

- `GET /api/v1/habits/{habitId}` は actor 自身の習慣(アーカイブ済みを含む)を `200` で返す。
- 存在しない、他ユーザー所有、`habitId` が UUID 形式でない場合はすべて同一の `404`(`code: habit_not_found`)。

### HAPI-004 習慣の更新(楽観ロック)

- `PATCH /api/v1/habits/{habitId}` は `version`(必須)と、`name`/`purpose`/`cue`/`minimumAction`/`replacementAction`(`null` で消去)/`schedule` のうち 1 つ以上を受け取る。
- 詳細の更新は Domain の `updateHabitDetails`、スケジュール変更は `changeSchedule`(有効開始日の保持、遡及編集拒否、有効期間重複拒否)に委ねる。両方指定された場合も 1 回の更新(1 transaction、`version` は +1 のみ)として扱う。
- 送信された `version` が現在の `version` と一致しない場合は `409`(`code: version_conflict`)。一致して成功した場合、`version` を 1 増やし、更新後の習慣を `200` で返す。
- `kind` は PATCH の入力に存在せず、指定すると未知キーとして `422`。
- アーカイブ済み習慣の更新は `409`(`code: habit_archived`)。

### HAPI-005 習慣のアーカイブ

- `POST /api/v1/habits/{habitId}/archive` は `version`(必須)を受け取り、Domain の `archiveHabit` で `archived` にして `200` で返す。`version` は +1。
- 既に `archived` の習慣への再実行は冪等とし、`version` が古くても `200` で現状を返す(クライアントの再送が 409 にならないようにするため)。`version` は増やさない。

## Business Rules and Invariants

- HAPI-INV-001(所有者限定): すべての repository クエリは actor user ID を条件に含む。取得後の所有者チェックに依存しない。他ユーザーの習慣は存在しないものと区別できない(404 / cursor 無効)。
- HAPI-INV-002(楽観ロック): 習慣の状態変更(詳細更新、スケジュール変更、アーカイブ)は「`version` が期待値と一致する行」にのみ適用され、適用ごとに `version` が 1 増える。習慣行と `habit_schedule_versions` の変更は同一 transaction で行い、部分的に反映されない。
- HAPI-INV-003(業務ルールは Domain のみ): kind 不変、reduce の targetCount=1、daysOfWeek の値域、有効期間の重複禁止等は Domain の関数だけが判定する。DB の CHECK/exclusion 制約は最終防衛線であり、Domain 検証より先に失敗させる設計にしない。
- HAPI-INV-004(pagination の決定性): 並び順は `(created_at desc, id desc)`、既存 index `habits_user_id_status_created_at_id_idx` に一致する。`created_at` は Application の Clock(ミリ秒精度)から設定し、JS `Date` と DB 間でマイクロ秒の丸めによる keyset のずれを起こさない。
- HAPI-INV-005(入力上限、暫定): `name` は 1〜100 文字、`purpose`/`cue`/`minimumAction`/`replacementAction` は 1〜500 文字(trim 前の文字数、UTF-16 code unit ではなく `String.length`)。制御文字(改行・タブ・NUL を含む)は拒否する。リクエスト body は 16 KiB まで。`daysOfWeek` は最大 7 要素。上限値は `docs/10` P2 が確定するまでの暫定既定値で、確定後は契約 schema の定数だけを変更する(Domain/DB は変更しない)。

## State Transitions

Domain の遷移表(`docs/specs/habit-domain.md`)をそのまま使用する。本タスクで追加される遷移はない。HTTP 上の対応:

| Current  | Action                       | Result                            |
| -------- | ---------------------------- | --------------------------------- |
| (none)   | POST /habits                 | active, version=1                 |
| active   | PATCH(version 一致)          | active, version+1                 |
| active   | PATCH(version 不一致)        | 変更なし、409 `version_conflict`  |
| active   | POST archive(version 一致)   | archived, version+1               |
| active   | POST archive(version 不一致) | 変更なし、409 `version_conflict`  |
| archived | PATCH                        | 変更なし、409 `habit_archived`    |
| archived | POST archive                 | 変更なし(冪等)、200、version 不変 |

## Acceptance Criteria

```gherkin
Scenario: buildの習慣を作成する
  Given ログイン済みのユーザー
  When kind=build、有効なname/purpose/cue/minimumAction、schedule(effectiveFrom, daysOfWeek=[1,2,3,4,5])でPOST /api/v1/habitsを呼ぶ
  Then 201とversion=1、status=activeの習慣が返る

Scenario: reduceでtargetCountが2は拒否される
  Given kind=reduceの作成リクエスト
  When schedule.targetCount=2で送る
  Then 422となり習慣は作成されない

Scenario: 他ユーザーの習慣は存在しないものとして扱う
  Given ユーザーAが作成した習慣
  When ユーザーBがそのidでGET/PATCH/archiveを呼ぶ
  Then すべて404(habit_not_found)で、ユーザーAの習慣は変更されない

Scenario: 古いversionでの更新は409
  Given version=1の習慣が別の更新でversion=2になっている
  When version=1でPATCHする
  Then 409(version_conflict)となり内容は変更されない

Scenario: 同一versionでの並行更新
  Given version=1の習慣
  When 同じversion=1で2件のPATCHを同時に実行する
  Then 1件だけ成功し、もう1件は409になる

Scenario: cursorによるページング
  Given 25件の習慣を持つユーザー
  When limit=10でnextCursorを辿って全ページを取得する
  Then 重複も欠落もなく25件が新しい順に得られ、最後のnextCursorはnull

Scenario: スケジュール変更で有効開始日が保持される
  Given effectiveFrom=2026-01-01のスケジュールを持つ習慣
  When schedule.effectiveFrom=2026-04-01でPATCHする
  Then 既存版のeffectiveFromは2026-01-01のままeffectiveToが2026-03-31になり、新版が追加される

Scenario: 未認証
  Given sessionを持たないリクエスト
  When いずれかのendpointを呼ぶ
  Then 401(unauthorized)
```

## Authorization Matrix

| Operation                 | Guest | Member(自分の習慣) | Member(他人の習慣) |
| ------------------------- | ----: | -----------------: | -----------------: |
| POST /habits              |   401 |                Yes |                N/A |
| GET /habits               |   401 |  Yes(自分の分のみ) |         含まれない |
| GET /habits/{id}          |   401 |                Yes |                404 |
| PATCH /habits/{id}        |   401 |                Yes |                404 |
| POST /habits/{id}/archive |   401 |                Yes |                404 |

Admin は本 Spec の対象外(T-403)。認可は Application/Infrastructure(actor user ID を含む query)で行い、認証(401)は Presentation で session から判定する。

## API and Events

共通: base path `/api/v1`、JSON、未知キー拒否、エラーは Problem Details(`code`、`message`、`fieldErrors`、`requestId`。既存の `createProblemDetails`)。応答に `Cache-Control: no-store`。request body を持つメソッド(POST/PATCH)は `Content-Type: application/json` 必須(違えば `415`)、body 16 KiB 超は `413`、JSON として解釈できない/schema 違反は `422`。状態変更メソッドは CSRF 対策として `Origin` ヘッダが `APP_BASE_URL` の origin と一致すること(`Origin` が無い場合は `Sec-Fetch-Site: same-origin` のみ許可)を要求し、満たさなければ `403`(`code: invalid_origin`)。Events は発行しない。

### Resource: Habit

```json
{
  "id": "uuid",
  "kind": "build",
  "name": "...",
  "purpose": "...",
  "cue": "...",
  "minimumAction": "...",
  "replacementAction": null,
  "status": "active",
  "version": 1,
  "scheduleVersions": [
    {
      "effectiveFrom": "2026-10-01",
      "effectiveTo": null,
      "daysOfWeek": [1, 2, 3, 4, 5],
      "targetCount": 1
    }
  ],
  "createdAt": "2026-10-01T00:00:00.000Z",
  "updatedAt": "2026-10-01T00:00:00.000Z"
}
```

`id` は `habits.public_id`(UUID)。内部 PK(`habits.id`)や `user_id` は応答・cursor に含めない。`scheduleVersions` は `effectiveFrom` 昇順。

### Endpoints

| Method/Path                      | 入力                                                                                                                         | 成功 | エラー                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------- |
| `POST /habits`                   | `kind`, `name`, `purpose`, `cue`, `minimumAction`, `replacementAction?`, `schedule{effectiveFrom, daysOfWeek, targetCount?}` | 201  | 401, 403, 413, 415, 422           |
| `GET /habits`                    | query: `status?`, `limit?`, `cursor?`                                                                                        | 200  | 401, 422                          |
| `GET /habits/{habitId}`          | path                                                                                                                         | 200  | 401, 404                          |
| `PATCH /habits/{habitId}`        | `version`, 詳細項目/`schedule{effectiveFrom, daysOfWeek, targetCount?}` のうち 1 つ以上                                      | 200  | 401, 403, 404, 409, 413, 415, 422 |
| `POST /habits/{habitId}/archive` | `version`                                                                                                                    | 200  | 401, 403, 404, 409, 413, 415, 422 |

- 409 の `code` は `version_conflict` または `habit_archived`。422 は schema 違反(`validation_failed`、`fieldErrors` に項目)と Domain 不変条件違反(reduce の targetCount≠1、遡及的なスケジュール変更等。`fieldErrors` は Domain エラー種別に応じた固定の項目名と固定文言)。
- 05 の契約例との差分: `schedule.localTime` は受け付けない(Out of Scope)。`schedule.effectiveFrom` を必須とする。`version` は `If-Match` ではなく body で受ける(PATCH/archive)。これらは `docs/05-api-and-ai-design.md` に追記する。
- 429 は返さない(Out of Scope)。

## Data and Migration

- Migration なし。使用する制約は既存のとおり: `habits_kind_check`/`habits_status_check`、`habits_user_id_fkey`(`ON DELETE CASCADE`)、`habits_public_id_key`、`habit_schedule_versions` の `UNIQUE(habit_id, effective_from)`、`days_of_week`/`target_count` の CHECK、有効期間の exclusion constraint。FK `habits.user_id` の index は `habits_user_id_status_created_at_id_idx` が先頭列で兼ねる。`habit_schedule_versions.habit_id` は `UNIQUE(habit_id, effective_from)` の先頭列で兼ねる。
- list のアクセスパターン `WHERE user_id = ? AND status = ? ORDER BY created_at DESC, id DESC` は上記 index に一致する。
- `habits.version` は作成時 1、状態変更ごとに +1。条件付き `UPDATE ... WHERE id = ? AND version = ?`(row lock)で競合を検出する。
- 日付(`effective_from`/`effective_to`)は `date`。Domain の `YYYY-MM-DD` 文字列と UTC 0 時の `Date` を相互変換する(タイムゾーンの影響を受けない)。
- rollback/forward fix: スキーマ変更なしのため、コードの revert のみで戻せる。
- 削除方針: 習慣は物理削除せずアーカイブ(`docs/04` 削除方針)。

## Failure and Edge Cases

- 他ユーザーの habitId / 存在しない habitId / UUID でない habitId → 404(区別しない)。
- 古い `version` → 409。並行更新 → 1 件のみ成功、他は 409。
- アーカイブ済みの更新 → 409(`habit_archived`)。アーカイブの再実行 → 200(冪等)。
- 不正な cursor(不正形式、他ユーザー/存在しない習慣、`status` 不一致)→ 422。
- 未知キー(`kind`、`userId`、`id`、`version` 以外の制御項目等)→ 422。PATCH で変更項目が 1 つもない → 422。
- DB 制約違反(Domain 検証をすり抜けた場合)や FK 違反(session の user が削除済み等)→ 内部エラー(500)。内部詳細は応答に含めない。
- 永続化済みの行が Domain の不変条件を満たさない(データ破損)→ 内部エラー(500)。内容は応答・ログに含めない。

## Security and Privacy

- Data collected: 習慣の自由記述(name/purpose/cue/minimumAction/replacementAction)。user ID は actor 取得のためのみに使用し、外部送信しない。外部 provider への送信なし。
- 保持/アクセス: 習慣は本人のみが参照・更新できる。アーカイブ後も保持。削除は T-404 のユーザー削除フローに従う。
- Data forbidden in logs: 習慣の自由記述、request body、session token、cookie、email。Presentation はこれらをログ出力しない。エラー応答に stack・SQL・DB エラー内容を含めない。
- IDOR/BOLA: HAPI-INV-001。cursor は習慣の外部 ID と status のみを含み、user ID・内部 ID を含めない。cursor を他ユーザーが流用しても actor 条件の query で解決できず 422。
- CSRF: `SameSite=Lax` cookie に加え、状態変更メソッドで Origin 検証と `Content-Type: application/json` 必須(単純リクエストによる CSRF を不可能にする)。
- XSS: API は JSON のみ返し HTML を返さない。自由記述は制御文字を拒否し、UI での表示時にエスケープする前提(UI は T-104 の対象外)。
- Injection: Prisma のパラメータ化クエリのみを使用し生 SQL を使わない。
- Abuse: 入力上限(HAPI-INV-005)、`limit` 最大 100、body 16 KiB。Rate limit は Out of Scope(Accepted Risks)。

## AI Requirements

N/A。AI を利用しない。

## Observability and Operations

- Logs: 本タスクでは route handler に自前のログ出力を追加しない(構造化ログ基盤は未導入で、`docs/06` の observability 整備タスクで共通化する)。予期しない例外は Next.js の標準エラー処理に委ね、応答は汎用 500 のみ。ログ導入時に出してよいのは route template、use case 名、status、duration、error code のみで、body・自由記述・ID は出さない。
- Metrics/Alerts: 既存方針(`docs/06`)の request count/error/latency に含まれる。専用の metric/alarm は追加しない。
- Runbook: 不要(新しい運用手順なし)。409/404 の増加は通常のクライアント競合として扱う。
- Rollout/rollback: Feature Flag なし(新規 route のみで既存機能に影響しない)。revert で完結する。Migration なしのため deploy 順序の制約なし。

## Test Coverage Matrix

| Requirement  | Unit                                                                         | Integration(実 PostgreSQL)                                                                                       | E2E                       |
| ------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------- |
| HAPI-001     | createHabit(fake repo)、契約 schema、HTTP handler の 201/422/401/403/413/415 | repository create→find の往復、DB の kind/days_of_week/重複 CHECK・exclusion 制約                                | N/A(E2E 基盤導入後に追加) |
| HAPI-002     | cursor 符号化/復号、listHabits(limit+1、status 不一致 cursor)、query schema  | 25 件のページング(重複/欠落なし)、status 絞り込み、同一 created_at の順序、他ユーザー cursor 拒否                | N/A                       |
| HAPI-003     | getHabit、handler の 404                                                     | 他ユーザーの習慣が見えない                                                                                       | N/A                       |
| HAPI-004     | updateHabit(version 不一致、archived、詳細+schedule)、handler の 409/422     | 条件付き更新、並行 2 更新で成功 1/409 1、スケジュール版の transaction 反映(effectiveTo の更新と新版追加が原子的) | N/A                       |
| HAPI-005     | archiveHabit(冪等、version 不一致)                                           | アーカイブ永続化、再実行の冪等、他ユーザー拒否                                                                   | N/A                       |
| HAPI-INV-001 | repository 呼び出しに actor が必ず渡ることを fake で検証                     | find/save/list の各経路で user B が user A の習慣に到達できない                                                  | N/A                       |
| HAPI-INV-002 | -                                                                            | habit 行の version 条件と schedule 変更の原子性(競合時に schedule が変わらない)                                  | N/A                       |
| HAPI-INV-005 | 契約 schema の境界値(100/101、500/501 文字、制御文字、daysOfWeek 8 要素)     | N/A                                                                                                              | N/A                       |
| 401/CSRF     | handler: session なしで 401、Origin 不一致/欠落で 403                        | N/A                                                                                                              | N/A                       |
| Domain 追加  | reconstituteHabit(正常復元、不変条件違反の拒否)                              | repository が復元に使用                                                                                          | N/A                       |

Fake/Stub 方針: Application の unit test は in-memory fake repository を使用(`test-fakes.ts`)。Integration Test は Testcontainers の実 PostgreSQL(既存 `startPostgresContainer`)。外部サービスなし。fixture はすべて架空データ。

## Open Questions

実装をブロックしない事項(既定値を置いて進める):

- **自由記述の文字数上限**(`docs/10` P2 で未決): HAPI-INV-005 の暫定値(name 100、他 500)を契約 schema にのみ置く。確定後に定数を更新し、必要なら Domain へ移す。
- **`localTime`**: 本タスクでは受け付けない(Out of Scope)。習慣ごとの通知時刻は T-401 の対象外（T-401 はユーザー単位の設定のみ）であり、必要になった時点で別タスクとして Domain `ScheduleVersion` への追加とあわせて設計する。
- **`effectiveFrom` の既定値**: クライアント指定を必須とした。T-102(timezone)完了後に「ユーザーのローカル今日」を既定にするかを再検討できる。
- **過去日への `effectiveFrom`**: Domain は「既存のどの版よりも後」のみを許可する。「今日より前を拒否する」ポリシーは timezone と Clock が必要なため本タスクでは課さない(Domain の `changeSchedule` コメントが示す Application 層の将来課題)。
- **reduce の `quantity` 意味論**(`docs/specs/habit-domain.md` の Open Question): 本タスクは `HabitEntry` を扱わないため影響しない。T-202 で解決済み(reduce は `quantity` を持たず `status` のみで判定。[habit-entry.md](habit-entry.md)、`docs/10` D-12)。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-10-02

| Gate                 | Result | Evidence                                                                                                                                  |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope。`docs/01` 機能要件 3、`docs/09` T-104                                                          |
| Specification        | Pass   | HAPI-001〜005、HAPI-INV-001〜005、State Transitions、Acceptance Criteria、Failure and Edge Cases。Open Questions は既定値付きで非ブロック |
| Domain and Time      | Pass   | Domain は T-103 を再利用。日付は `date`⇔`YYYY-MM-DD` で timezone 非依存。`created_at` は Clock 注入。楽観ロックと冪等アーカイブを定義     |
| API and Data         | Pass   | API and Events 節、Data and Migration 節(Migration なし、既存 index/制約の確認、transaction、pagination)                                  |
| Security and Privacy | Pass   | Security and Privacy 節、Authorization Matrix(IDOR/CSRF/XSS/Injection/abuse、ログ禁止事項、入力上限)                                      |
| AI                   | N/A    | AI を利用しない                                                                                                                           |
| Testing              | Pass   | Test Coverage Matrix(要件 ID × test 種別、fake 方針)。E2E は基盤未導入のため N/A と理由を明記                                             |
| Operations           | Pass   | Observability and Operations 節(ログ方針、rollout/rollback、Runbook 不要の理由)                                                           |
| Planning             | Pass   | [../plans/habit-api.md](../plans/habit-api.md)                                                                                            |

### Accepted Risks

- `Idempotency-Key` 未対応のため、POST の二重送信で習慣が重複作成されうる(習慣はアーカイブで整理可能で、データ破損にはならない)。共通の冪等性基盤の導入時に追加する。
- Rate limit 未実装のため、認証済みユーザーによる大量作成を制限できない(入力上限と pagination 上限のみ)。P2 の閾値確定後に共通基盤として追加する。
- 構造化ログ未導入のため、本 API 固有の運用 metric/ログは追加しない。

### Open Questions

上記「Open Questions」節のとおり(すべて非ブロック)。
