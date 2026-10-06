# Habit Entry Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-03
変更区分: Standard
ロードマップ項目: T-202

## 目的

ログイン済みのユーザーが、自分のローカル日の「今日の予定」を確認し、予定された習慣の実施結果(成功/未実施/スキップ)を記録・訂正できるようにする。T-201 の予定機会計算と T-103/T-104 の Habit を再利用し、「手動で価値が成立する記録」の核を提供する。

## 成功指標

- `GET /api/v1/schedule/today` が、ユーザーの timezone のローカル日に予定されている active な習慣と、その日の記録の有無を返す(Integration Test で実 PostgreSQL に対して確認)。
- `PUT /api/v1/habits/{habitId}/entries/{date}` が冪等な upsert として動作し、同一内容の再送・並行送信でも 1 習慣 1 日 1 レコードのまま、重複や 500 が起きない。
- 他ユーザーの習慣への記録・他ユーザーの記録の参照は常に 404 または一覧に含まれず、IDOR が成立しない。
- 成功判定(build の `quantity >= targetCount`)・予定日判定・対象日の範囲判定を Application/Presentation/Infrastructure で再実装していない(Domain の公開関数のみを使用)。

## 範囲

- Domain(tracking): 記録の入力(`status`、`quantity`)を habit の kind と、その日に適用される ScheduleVersion の `targetCount` に対して検証・正規化する純粋関数 `resolveHabitEntry`。
- Application: `getTodaySchedule`、`upsertHabitEntry` の use case、`HabitEntryRepositoryPort`、Application error。
- Infrastructure: `PrismaHabitEntryRepository`(`habit_entries` の冪等 upsert、日付別一覧)。
- Contracts: request/response/path の runtime schema(zod、`.strict()`)。
- Presentation(`apps/web`): `GET /api/v1/schedule/today`、`PUT /api/v1/habits/{habitId}/entries/{date}`。
- DB: Migration を 1 件追加する(`habit_entries.quantity` の値域 CHECK)。他のスキーマ変更なし。
- 文書: `docs/05-api-and-ai-design.md`、`docs/04-database-design.md`、`docs/10-decisions-and-open-questions.md`、`docs/09-roadmap.md`。

## 対象外

- `GET /habit-entries`(期間・習慣指定の履歴)、統計・ストリーク(T-204)、daily check-in(T-203)。
- 記録の `note`(自由記述)。文字数上限が `docs/10` P2 で未決のため、本タスクでは API に含めず列は常に `NULL` とする。
- `source = 'system'` の記録(自動記録)。本 API は常に `web`。
- `Idempotency-Key` ヘッダと `idempotency_keys` テーブル。`PUT` は自然キー `(habit, date)` で冪等であり不要。
- アーカイブ済み習慣への記録、予定のない日・今日より未来の日・過去 7 日より前の日への記録。
- Rate limit、Playwright E2E(基盤未導入。AGENTS.md の方針)。
- 記録の削除(訂正は status の更新で行う)。

## アクターと前提条件

| Actor                  | Preconditions                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Guest(未認証)          | なし。すべての endpoint で `401`                                                      |
| Member(email 確認済み) | T-101 の session を持つ。timezone は T-102 のプロフィール(未作成なら既定値で遅延作成) |

actor の user ID は session(`session.user.id`)のみから取得し、request の body/query/path/header から受け取らない。

## 機能要件

### HENT-001 今日の予定の取得

- `GET /api/v1/schedule/today` は、actor のプロフィール timezone でのローカル日(`localDateAt(now, timezone)`)を「今日」とし、その日に予定機会がある **active** な習慣の一覧を返す。
- 各 item は、習慣の表示用項目(`id`、`kind`、`name`、`cue`、`minimumAction`、`replacementAction`)、その日の `targetCount`、および当日の記録(`entry`)を持つ。記録がなければ `entry` は `null`。
- 予定機会の判定は T-201 の `scheduledOccurrenceOn` のみを使う。アーカイブ済みの習慣は含めない。
- item は習慣の作成が古い順に返す。予定がなければ `items` は空配列(200)。
- 応答に `date`(今日のローカル暦日)と `timezone` を含める。クライアントは `date` を `PUT` の日付に使う。

### HENT-002 記録の作成・訂正(冪等 upsert)

- `PUT /api/v1/habits/{habitId}/entries/{date}` は body `{ status, quantity? }` を受け取り、`200` と保存後の記録を返す。同じ `(habitId, date)` への再送・訂正は上書きされ、レコードは増えない。同一内容の再送は同一の結果を返す。
- `status` は `success`、`missed`、`skipped` のいずれか。
- 検証・正規化は Domain の `resolveHabitEntry` が行う(HENT-003)。
- 保存する値は actor の習慣に対してのみ書き込まれる(HENT-INV-001)。
- 同じ `(habitId, date)` への並行 `PUT` は、どれも成功(200)し、最終的に 1 レコードになる(後勝ち)。

### HENT-003 記録内容の検証(Domain)

`resolveHabitEntry(kind, targetCount, input)` は次を満たす記録内容を返し、満たさなければ `InvalidHabitEntryError` を投げる。

| kind   | status    | quantity の扱い                                                                                        |
| ------ | --------- | ------------------------------------------------------------------------------------------------------ |
| build  | `success` | 0 以上 1000 以下の整数。省略時は `targetCount`。`targetCount` 以上でなければ拒否                       |
| build  | `missed`  | 0 以上 1000 以下の整数。省略時は 0。`targetCount` 未満でなければ拒否(途中経過の記録)                   |
| build  | `skipped` | 指定不可(保存は `null`)                                                                                |
| reduce | すべて    | 指定不可(保存は `null`)。成功は `status = success` が「回避できた」、`missed` が「してしまった」を表す |

- build の `success` は「`isTargetMet(version, quantity)`」と同値であり、`status` と `quantity` が矛盾する記録を作れない。
- reduce の意味論は `status` のみで決める(`quantity` の意味論を持たない)。これにより T-103 Spec の Open Question を解決する。

### HENT-004 対象日の検証

- `{date}` は実在する暦日(`YYYY-MM-DD`)であること。
- `date` は、actor の「今日」(`localDateAt(now, timezone)`)から過去 7 日前までの範囲(今日を含む、計 8 日)に収まること。未来日・範囲外は `422`(`code: entry_date_out_of_range`)。
- `date` に当該習慣の予定機会がない(曜日が対象外、有効期間外)場合は `422`(`code: habit_not_scheduled`)。
- アーカイブ済みの習慣への記録は `409`(`code: habit_archived`)。
- 習慣が存在しない、他ユーザーの所有、`habitId` が UUID でない場合は同一の `404`(`code: habit_not_found`)。

## 業務ルールと不変条件

- HENT-INV-001(所有者限定): すべての repository 操作は actor user ID を条件に含み、取得後の所有者チェックに依存しない。他ユーザーの習慣・記録は存在しないものと区別できない。
- HENT-INV-002(一意性): 1 習慣 1 日につき記録は高々 1 件(DB の `UNIQUE (habit_id, habit_date)`)。複数回実施は `quantity` で表す。upsert は `INSERT ... ON CONFLICT (habit_id, habit_date) DO UPDATE` の単一文で行い、並行時も一意制約違反を起こさない。
- HENT-INV-003(日付の基準): 「今日」と対象日の範囲は常に actor のプロフィール timezone と注入された Clock から決める。`habit_date` はローカル暦日(`date`)で、timezone を変更しても既存の `habit_date` は変えない。
- HENT-INV-004(業務ルールは Domain のみ): 予定日判定は `scheduledOccurrenceOn`、成功判定は `resolveHabitEntry`(`isTargetMet` と同値)のみが行う。
- HENT-INV-005(対象日の範囲定数): 過去に遡れる日数(7)は Application の定数 `ENTRY_BACKDATE_LIMIT_DAYS` 1 箇所のみで定義する。

## 状態遷移

| Current                 | Action          | Next                                     | Rejected when                                              |
| ----------------------- | --------------- | ---------------------------------------- | ---------------------------------------------------------- |
| (記録なし)              | PUT(有効な内容) | 記録あり(新規作成)                       | 範囲外の日付、予定なし、内容が不正、習慣が archived/不存在 |
| 記録あり(任意の status) | PUT(有効な内容) | 記録あり(上書き。status/quantity を置換) | 同上                                                       |

`status` 間の遷移に制約はない(訂正のため success→missed 等を許す)。記録の削除はない。

## 受け入れ基準

```gherkin
Scenario: 今日の予定を取得する
  Given timezone が Asia/Tokyo、月曜に予定された active な build 習慣がある
  And Clock が 2026-01-05T15:00:00Z(Asia/Tokyo では 2026-01-06 火曜)
  When GET /api/v1/schedule/today を呼ぶ
  Then date は 2026-01-06 で、月曜のみの習慣は items に含まれない

Scenario: 予定された習慣に成功を記録する
  Given 今日が予定日の build(targetCount=1)習慣
  When PUT /habits/{id}/entries/{今日} に {status: "success"} を送る
  Then 200 で status=success、quantity=1 が返る
  And GET /schedule/today の該当 item の entry に同じ内容が入る

Scenario: 複数回の build で目標未達は missed のみ許される
  Given targetCount=3 の build 習慣
  When {status: "success", quantity: 2} を送る
  Then 422 になり記録されない
  And {status: "missed", quantity: 2} は 200 で保存される

Scenario: 訂正は同じレコードを上書きする
  Given 今日の記録が missed
  When 同じ日付へ {status: "success"} を PUT する
  Then 200 で status=success に更新され、記録は 1 件のまま

Scenario: 同一内容の再送は同じ結果
  When 同じ body で 2 回 PUT する
  Then どちらも 200 で同一の記録が返り、レコードは 1 件

Scenario: reduce は quantity を受け付けない
  Given reduce の習慣
  When {status: "success", quantity: 1} を送る
  Then 422 になる
  And {status: "success"} は 200 で quantity=null

Scenario: 未来日・古すぎる日・予定のない日
  Given 今日が 2026-01-14(水)
  When 2026-01-15、2026-01-06(8 日前)へ PUT する
  Then どちらも 422 entry_date_out_of_range
  And 2026-01-13(予定のない曜日)へ PUT すると 422 habit_not_scheduled

Scenario: 他ユーザーの習慣
  Given ユーザー A の習慣
  When ユーザー B がその habitId へ PUT する
  Then 404 habit_not_found で何も作られない

Scenario: DST の日
  Given timezone が America/New_York、Clock が 2026-03-09T03:30:00Z(現地は 2026-03-08 の 23:30)
  When GET /schedule/today を呼ぶ
  Then date は 2026-03-08

Scenario: 並行送信
  When 同じ (habit, date) へ 2 件の PUT を同時に実行する
  Then どちらも 200 で、記録は 1 件
```

## 認可マトリクス

| Operation                            | Guest | Member(自分の習慣) | Member(他人の習慣) |
| ------------------------------------ | ----: | -----------------: | -----------------: |
| GET /schedule/today                  |   401 |  Yes(自分の分のみ) |         含まれない |
| PUT /habits/{habitId}/entries/{date} |   401 |                Yes |                404 |

Admin は対象外(T-403)。認証(401)は Presentation で session から判定し、認可は actor user ID を含む query で行う。

## APIとイベント

共通: base path `/api/v1`、JSON、未知キー拒否、エラーは Problem Details(`createProblemDetails`)、応答に `Cache-Control: no-store`。`PUT` は `Content-Type: application/json` 必須(`415`)、body 上限 16 KiB(`413`)、状態変更メソッドの Origin 検証(`403 invalid_origin`)。T-104 と同じ共通処理を再利用する。Events は発行しない。

| Method/Path                            | 入力                        | 成功 | エラー                            |
| -------------------------------------- | --------------------------- | ---- | --------------------------------- |
| `GET /schedule/today`                  | なし                        | 200  | 401                               |
| `PUT /habits/{habitId}/entries/{date}` | body: `status`, `quantity?` | 200  | 401, 403, 404, 409, 413, 415, 422 |

### Resource: TodaySchedule

```json
{
  "date": "2026-01-06",
  "timezone": "Asia/Tokyo",
  "items": [
    {
      "habit": {
        "id": "uuid",
        "kind": "build",
        "name": "...",
        "cue": "...",
        "minimumAction": "...",
        "replacementAction": null
      },
      "targetCount": 1,
      "entry": { "status": "success", "quantity": 1, "updatedAt": "2026-01-06T01:00:00.000Z" }
    }
  ]
}
```

### Resource: HabitEntry

```json
{
  "habitId": "uuid",
  "date": "2026-01-06",
  "status": "success",
  "quantity": 1,
  "updatedAt": "2026-01-06T01:00:00.000Z"
}
```

- 内部 PK、`user_id`、`habit_entries.public_id` は応答に含めない。
- 422 の `code` は `validation_failed`(schema 違反、`fieldErrors` に項目)、`entry_date_out_of_range`、`habit_not_scheduled`、`invalid_habit_entry`(Domain の記録内容違反。`fieldErrors.quantity` / `status` に固定文言)。
- 05 の契約例との差分: `GET /schedule/today` の応答形、`PUT` の body(`note` を受け付けない)、`quantity` の扱いを `docs/05-api-and-ai-design.md` に反映する。

## データとMigration

- Migration を 1 件追加する(expand のみ、後方互換): `habit_entries_quantity_check CHECK (quantity IS NULL OR (quantity >= 0 AND quantity <= 1000))`。`habit_entries` は T-202 以前にアプリが書き込んでおらず既存行がないため backfill は不要。`NOT VALID` は使わない。rollback は forward fix(制約の drop migration を追加)。fresh DB と既存スキーマからのアップグレードの両方を Integration Test で検証する(既存の migration 検証と同じ方法)。
- 既存の制約・index を利用する: `habit_entries_status_check`、`source_check`、`UNIQUE(habit_id, habit_date)`、`(user_id, habit_date desc, id desc)`、FK `habit_id`/`user_id`(`ON DELETE CASCADE`)。FK `habit_id` の index は `UNIQUE(habit_id, habit_date)` の先頭列、`user_id` は `(user_id, habit_date, id)` の先頭列で兼ねる。
- today query のアクセスパターン `WHERE user_id = ? AND habit_date = ?` は `(user_id, habit_date desc, id desc)` に一致する。
- `quantity` は `numeric`。T-202 は整数のみ書き込み、読み出しは整数であることを検証する(非整数の保存値はデータ破損として内部エラー)。
- `habit_date` は `date`、`created_at`/`updated_at` は呼び出し側 Clock のミリ秒精度。`scheduled_for` と `note` は書かない(`NULL`)。

## 失敗・境界ケース

- `date` が実在しない暦日・形式不正 → 422 `validation_failed`(`fieldErrors.date`)。
- 未来日、8 日以上前 → 422 `entry_date_out_of_range`。予定のない日 → 422 `habit_not_scheduled`。
- build の success で `quantity < targetCount`、missed で `quantity >= targetCount`、skipped/reduce で `quantity` 指定、負数・小数・1000 超 → 422 `invalid_habit_entry`(契約 schema で整数/範囲外は 422 `validation_failed`)。
- 習慣の timezone 変更直後: 「今日」は新 timezone で決まり、既存の `habit_date` は変わらない。同じ暦日が 2 回現れる/飛ぶ場合も、対象日の範囲判定と一意制約により記録の重複は起きない。
- 日付境界(ローカル 0 時)を挟む送信: 判定は use case の `now()` 1 回で行い、同一リクエスト内で「今日」を再計算しない。
- 習慣が検証後に archived になった競合: upsert は習慣の存在と所有を条件にするが archived は条件にしない(許容。記録は有効な履歴として残る)。
- session の user が削除済み(プロフィール/習慣が見つからない)→ 404。
- DB 制約違反(Domain 検証をすり抜けた場合)→ 内部エラー(500)。内部詳細は応答に含めない。
- 保存済みの記録が不変条件を満たさない(データ破損)→ 内部エラー(500)。内容は応答・ログに含めない。

## セキュリティとプライバシー

- 収集データ: 記録の status、quantity、日付(ユーザーの行動履歴)。user ID は actor 取得のみに使用し外部送信しない。外部 provider への送信なし。
- 保持/アクセス: 本人のみ参照・更新可。削除は T-404 のユーザー削除フロー(`ON DELETE CASCADE`)に従う。
- ログ禁止データ: request body、session、cookie、email、習慣の自由記述。本タスクで route に独自ログを追加しない(T-104 と同じ方針)。エラー応答に stack・SQL・DB エラー内容を含めない。
- IDOR/BOLA: HENT-INV-001。habit は `public_id` と `user_id` の両方で解決する。URL の `habitId` だけで他人の習慣へ書けない。
- CSRF: Origin 検証 + `Content-Type: application/json` 必須(T-104 と同じ)。XSS: JSON のみを返す。Injection: Prisma のパラメータ化クエリ(upsert は `$queryRaw` のタグ付きテンプレートでバインド変数のみを使い、文字列連結をしない)。
- Abuse: `quantity` 上限 1000、対象日の範囲(過去 7 日〜今日)、body 16 KiB。Rate limit は 対象外(受容リスク)。

## AI要件

N/A。AI を利用しない。

## 可観測性と運用

- ログ: route に独自ログを追加しない(構造化ログ基盤が未導入。導入時に出してよいのは route template、use case 名、status、duration、error code のみ)。
- Metrics/Alerts: 既存方針(`docs/06`)の request count/error/latency に含まれる。専用 metric/alarm は追加しない。
- Runbook: 不要(新しい運用手順なし)。422 の増加はクライアントの日付/timezone 不整合の兆候として参照する。
- 展開/ロールバック: Feature Flag なし(新規 route のみ)。Deployment order: Migration を先に適用してからアプリを deploy する(古いアプリは新 route を持たないため互換)。rollback はアプリの revert。制約の撤去が必要な場合は forward fix の Migration を追加する。

## テスト対応表

| 要件         | Unit                                                                                                         | Integration(実 PostgreSQL)                                                   | E2E                       |
| ------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------- |
| HENT-001     | `getTodaySchedule`(fake repo: ローカル日、timezone 差、非予定日、archived 除外、記録の結合、DST 日)、handler | repository の日付別一覧、他ユーザーの記録が含まれない                        | N/A(E2E 基盤導入後に追加) |
| HENT-002     | `upsertHabitEntry`(fake repo: 作成/訂正/再送)、handler の 200/401/403/404/409/413/415/422                    | upsert の作成→更新、同一内容の再送、並行 2 件で 1 レコード、各 status の往復 | N/A                       |
| HENT-003     | `resolveHabitEntry`(build/reduce × status × quantity の境界値)、契約 schema                                  | DB の quantity CHECK(負数/1001 を拒否)                                       | N/A                       |
| HENT-004     | 範囲境界(今日・7 日前・8 日前・未来)、タイムゾーン日付境界、非予定日、archived、不存在                       | 他ユーザーの habit への upsert が何も書かない                                | N/A                       |
| HENT-INV-001 | repository 呼び出しに actor が必ず渡ることを fake で検証                                                     | find/upsert/list の各経路で user B が user A の習慣・記録に到達できない      | N/A                       |
| HENT-INV-002 | -                                                                                                            | 一意制約と ON CONFLICT、並行 upsert                                          | N/A                       |
| Migration    | -                                                                                                            | fresh DB と既存スキーマからのアップグレードで制約が存在する                  | N/A                       |

Fake/Stub 方針: Application の unit test は in-memory fake(`test-fakes.ts`)と固定 Clock、プロフィールは既存の fake を使用。Integration は Testcontainers の実 PostgreSQL。fixture は架空データのみ。

## 未決事項

実装をブロックしない事項:

- **記録の `note`**: P2(文字数上限)確定後に別タスクで追加する。列は残る。
- **履歴 `GET /habit-entries`**: T-204(統計)または UI タスクで必要になった時点で Spec 化する。
- **過去記録の遡及上限(7 日)**: 暫定値。利用実態を見て定数のみ変更する。
- **習慣数の上限**: today query は active な習慣を全件走査する。習慣数の上限が決まるまで性能上限は未定義(受容リスク)。

決定済み(2026-10-03 ユーザー確認): reduce は `quantity` を使わず `status` のみで判定する。対象日は今日と過去 7 日まで。予定のない日への記録は拒否(422)する。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-03
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                          |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope。`docs/02` 日次記録、`docs/09` T-202                                                    |
| Specification        | Pass   | HENT-001〜004、HENT-INV-001〜005、State Transitions、Acceptance Criteria、Failure and Edge Cases。未決事項は非ブロック            |
| Domain and Time      | Pass   | T-201 の `localDateAt`/`scheduledOccurrenceOn` を使用、Clock 注入、timezone 変更・DST・日付境界を明記。冪等性・並行は ON CONFLICT |
| API and Data         | Pass   | API and Events、Data and Migration(CHECK 追加、expand のみ、index 確認、rollback は forward fix)                                  |
| Security and Privacy | Pass   | Security and Privacy、Authorization Matrix(IDOR/CSRF/XSS/Injection/abuse、ログ禁止、入力上限)                                     |
| AI                   | N/A    | AI を利用しない                                                                                                                   |
| Testing              | Pass   | Test Coverage Matrix(要件 ID × test 種別)。E2E は基盤未導入のため N/A と理由を明記                                                |
| Operations           | Pass   | Observability and Operations(ログ方針、deploy 順序、rollback)                                                                     |
| Planning             | Pass   | [../plans/habit-entry.md](../plans/habit-entry.md)                                                                                |

### 受容リスク

- Rate limit 未実装(T-104 と同じ)。入力上限と対象日の範囲のみで抑える。
- today query は active 習慣を全件走査する。習慣数の上限が未定義のため、極端に多い習慣を持つユーザーで遅くなりうる(index は利用される)。上限の導入時に見直す。
- 同日の `PUT` 並行は後勝ち。クライアントが古い画面から訂正すると、別端末の記録を上書きしうる(楽観ロックは日次記録の単純さを優先して導入しない)。
- 構造化ログ未導入のため、本 API 固有の運用ログ/metric は追加しない。
