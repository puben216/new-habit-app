# Daily Check-in Spec

Status: Ready
Owner: TBD
Last updated: 2026-10-03
Change classification: Standard
Roadmap Task: T-203

## Goal

ログイン済みのユーザーが、その日の気分・難易度・メモを 1 日 1 件のチェックインとして保存・訂正・取得できるようにする(UC-10)。習慣の実行記録(T-202)とは独立に、「今日どうだったか」を最小の入力で残せる。週次継続率(WAU: 週 3 日以上のチェックイン)と週次レビュー(T-301)の入力になる。

## Success Metrics

- `PUT /api/v1/daily-check-ins/{date}` が冪等な upsert として動作し、同一内容の再送・並行送信でも 1 ユーザー 1 日 1 レコードのまま、重複や 500 が起きない(Integration Test で確認)。
- 対象日(今日と過去 7 日)の判定が、ユーザーの timezone のローカル日(T-201 の `localDateAt`)で行われ、DST 日・日付境界を Unit Test で確認している。
- 他ユーザーのチェックインは取得も更新もできず、path にユーザーを指定する余地がない(actor は session のみ)。
- mood/difficulty の値域・メモの正規化を Domain の関数だけが判定し、Application/Presentation/Infrastructure で再実装していない。

## Scope

- Domain(tracking): `resolveDailyCheckIn`(mood/difficulty の 1〜5、メモの正規化、「少なくとも 1 項目」ルール)。
- Application: `getDailyCheckInUseCase`、`upsertDailyCheckInUseCase`、`DailyCheckInRepositoryPort`、Application error。
- Infrastructure: `PrismaDailyCheckInRepository`(`daily_check_ins` の冪等 upsert と取得)。
- Contracts: request/response/path の runtime schema(zod、`.strict()`)。
- Presentation(`apps/web`): `GET/PUT /api/v1/daily-check-ins/{date}`。
- 内部整理: T-202 の「actor の今日を求める」処理を tracking 内の共通関数へ切り出す(振る舞いは変えない)。
- 文書: `docs/04`、`docs/05`、`docs/09`、`docs/10`(P2 の暫定上限)。

## Out of Scope

- 履歴一覧・期間取得(`GET /daily-check-ins?from=&to=`)、集計・WAU の算出(T-204 以降)。
- チェックインの削除(訂正は上書きで行う。全項目を空にする更新は拒否する)。
- 習慣ごとのメモ(`habit_entries.note`)。
- DB の変更(`mood`/`difficulty` の CHECK は既存。Migration なし)。
- Rate limit、Playwright E2E(基盤未導入)、AI への入力(メモを AI/analytics へ送らない)。

## Actors and Preconditions

| Actor                  | Preconditions                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Guest(未認証)          | なし。すべての endpoint で `401`                                                    |
| Member(email 確認済み) | T-101 の session を持つ。timezone は T-102 のプロフィール(未作成なら既定で遅延作成) |

actor の user ID は session のみから取得し、request の body/query/path/header から受け取らない。

## Functional Requirements

### DCI-001 チェックインの作成・訂正(冪等 upsert)

- `PUT /api/v1/daily-check-ins/{date}` は body `{ mood?, difficulty?, note? }` を受け取り、`200` と保存後のチェックインを返す。
- `PUT` は対象日のチェックイン全体の置き換えである。body に含めない項目、または `null` の項目は未設定(`null`)として保存される(部分更新ではない)。
- 同じ `(actor, date)` への再送・訂正は上書きされ、レコードは増えない。同一内容の再送は同一の内容を返す。並行 `PUT` はすべて成功し、後勝ちで 1 レコードに収束する。

### DCI-002 内容の検証(Domain)

`resolveDailyCheckIn(input)` は次を満たす内容を返し、満たさなければ `InvalidDailyCheckInError` を投げる。

- `mood`、`difficulty`: 1〜5 の整数、または未設定(`null`/省略)。
- `note`: 未設定または文字列。前後の空白を除去し、空になれば未設定として扱う。
- 3 項目がすべて未設定になる入力は拒否する(空のチェックインは保存しない)。

文字数上限と制御文字の検査は契約 schema が行う(DCI-INV-004)。

### DCI-003 対象日の検証

- `{date}` は実在する暦日(`YYYY-MM-DD`)であること。
- `PUT` の対象日は、actor の「今日」(`localDateAt(now, timezone)`)から過去 7 日前までの範囲(今日を含む、計 8 日)であること。未来日・範囲外は `422`(`code: check_in_date_out_of_range`)。
- 予定の有無・習慣の有無は問わない(習慣がなくてもチェックインできる)。

### DCI-004 チェックインの取得

- `GET /api/v1/daily-check-ins/{date}` は、actor 自身のその日のチェックインを `200` で返す。なければ `404`(`code: check_in_not_found`)。
- `GET` の対象日に範囲制限はない(実在する暦日であればよい)。不正な暦日は `422`。

## Business Rules and Invariants

- DCI-INV-001(所有者限定): すべての repository 操作は actor user ID を条件に含む。API に他ユーザーを指定する手段がない。
- DCI-INV-002(一意性): 1 ユーザー 1 日につきチェックインは高々 1 件(DB の `UNIQUE (user_id, check_in_date)`)。upsert は `INSERT ... ON CONFLICT (user_id, check_in_date) DO UPDATE` の単一文で行う。
- DCI-INV-003(日付の基準): 「今日」と対象日の範囲は actor のプロフィール timezone と注入された Clock から決める。`check_in_date` は変更後の timezone でも書き換えない。
- DCI-INV-004(入力上限、暫定): `note` は 1〜1000 文字(trim 前の `String.length`)。改行(`\n`)とタブは許可し、それ以外の制御文字(NUL を含む)は拒否する。body は 16 KiB まで。上限値は `docs/10` P2 が確定するまでの暫定値で、確定後は契約 schema の定数だけを変更する(Domain/DB は変更しない)。
- DCI-INV-005(過去に遡れる日数): Application の定数 `CHECK_IN_BACKDATE_LIMIT_DAYS`(7)1 箇所のみで定義する。

## State Transitions

| Current            | Action          | Next               | Rejected when                                  |
| ------------------ | --------------- | ------------------ | ---------------------------------------------- |
| (チェックインなし) | PUT(有効な内容) | あり(新規作成)     | 範囲外の日付、内容が不正(全項目が未設定を含む) |
| あり               | PUT(有効な内容) | あり(全項目を置換) | 同上                                           |

削除はない。

## Acceptance Criteria

```gherkin
Scenario: 今日のチェックインを保存して取得する
  Given Clock が 2026-01-14T03:00:00Z、timezone が Asia/Tokyo
  When PUT /daily-check-ins/2026-01-14 に {mood: 4, difficulty: 2, note: "歩いた"} を送る
  Then 200 で同じ内容が返る
  And GET /daily-check-ins/2026-01-14 で同じ内容が取得できる

Scenario: 訂正は全体を置き換える
  Given mood=4, difficulty=2, note="歩いた" のチェックイン
  When {mood: 5} だけを PUT する
  Then mood=5、difficulty と note は null になり、レコードは 1 件のまま

Scenario: 空のチェックインは拒否する
  When {} または {mood: null, note: "   "} を PUT する
  Then 422(invalid_check_in)で何も保存されない

Scenario: 値域
  When mood=0、mood=6、difficulty=1.5 を送る
  Then 422 になる
  And mood=1 と mood=5 は 200

Scenario: 対象日の範囲
  Given 今日が 2026-01-14
  When 2026-01-15(未来)と 2026-01-06(8 日前)を PUT する
  Then どちらも 422 check_in_date_out_of_range
  And 2026-01-07(7 日前)は 200

Scenario: ローカル日で判定する
  Given timezone が Asia/Tokyo、Clock が 2026-01-13T20:00:00Z(Tokyo では 2026-01-14)
  When 2026-01-14 へ PUT する
  Then 200(UTC では未来日だがローカルでは今日)

Scenario: DST の日
  Given timezone が America/New_York、Clock が 2026-03-09T03:30:00Z(現地は 2026-03-08 23:30)
  When 2026-03-08 へ PUT、2026-03-09 へ PUT する
  Then 前者は 200、後者は 422

Scenario: 他ユーザーのチェックインは見えない
  Given ユーザー A の 2026-01-14 のチェックイン
  When ユーザー B が GET /daily-check-ins/2026-01-14 を呼ぶ
  Then 404 check_in_not_found

Scenario: 並行送信
  When 同じ日へ 2 件以上の PUT を同時に実行する
  Then すべて 200 で、レコードは 1 件
```

## Authorization Matrix

| Operation                   | Guest | Member(自分) |           Member(他人) |
| --------------------------- | ----: | -----------: | ---------------------: |
| GET /daily-check-ins/{date} |   401 |          Yes | 到達不可(自分の分のみ) |
| PUT /daily-check-ins/{date} |   401 |          Yes | 到達不可(自分の分のみ) |

path にユーザーを含めないため IDOR の経路がない。Admin は対象外(T-403)。

## API and Events

共通: base path `/api/v1`、JSON、未知キー拒否、Problem Details、`Cache-Control: no-store`。`PUT` は `Content-Type: application/json` 必須(`415`)、body 上限 16 KiB(`413`)、Origin 検証(`403 invalid_origin`)。T-104/T-202 と同じ共通処理を再利用する。Events は発行しない。

| Method/Path                   | 入力                                  | 成功 | エラー                       |
| ----------------------------- | ------------------------------------- | ---- | ---------------------------- |
| `GET /daily-check-ins/{date}` | path                                  | 200  | 401, 404, 422                |
| `PUT /daily-check-ins/{date}` | body: `mood?`, `difficulty?`, `note?` | 200  | 401, 403, 404, 413, 415, 422 |

### Resource: DailyCheckIn

```json
{
  "date": "2026-01-14",
  "mood": 4,
  "difficulty": 2,
  "note": "歩いた",
  "updatedAt": "2026-01-14T03:00:00.000Z"
}
```

- 内部 PK、`user_id` は応答に含めない。未設定の項目は `null`。
- 422 の `code`: `validation_failed`(schema 違反。`fieldErrors` に項目)、`check_in_date_out_of_range`、`invalid_check_in`(Domain の内容違反。全項目が未設定を含む)。
- `404` は `check_in_not_found`(GET でチェックインがない)、`user_not_found`(session の user が存在しない)。

## Data and Migration

- Migration なし。既存の `daily_check_ins`(`UNIQUE(user_id, check_in_date)`、`mood`/`difficulty` の CHECK 1〜5、FK `ON DELETE CASCADE`)を使う。FK `user_id` の index は `UNIQUE(user_id, check_in_date)` の先頭列で兼ねる。
- アクセスパターン `WHERE user_id = ? AND check_in_date = ?` は上記 unique index に一致する。
- `note` の文字数の DB CHECK は追加しない(P2 未決の暫定値を DB に焼き込まないため。契約 schema が上限)。
- `check_in_date` は `date`、`created_at` は新規作成時のみ Clock の値、更新時の `updated_at` は既存の `set_updated_at` trigger が決める(T-202 と同じ)。
- rollback: スキーマ変更なしのため、アプリの revert のみで戻せる。

## Failure and Edge Cases

- 不正な暦日(`2026-02-30`、形式違い)→ 422 `validation_failed`(`fieldErrors.date`)。
- 未来日、8 日以上前 → 422 `check_in_date_out_of_range`。
- mood/difficulty が 1〜5 以外、小数、文字列 → 422 `validation_failed`。
- すべて未設定、メモが空白のみで他が未設定 → 422 `invalid_check_in`。
- メモが 1001 文字以上、`\n`/`\t` 以外の制御文字 → 422 `validation_failed`。
- timezone 変更直後: 「今日」は新 timezone で決まり、既存の `check_in_date` は変わらない。
- session の user が削除済み → 404 `user_not_found`。
- DB 制約違反(Domain/契約をすり抜けた場合)→ 内部エラー(500)。内部詳細は応答に含めない。

## Security and Privacy

- Data collected: 気分・難易度・メモ(健康に関わりうる自由記述を含む個人データ)。user ID は actor 取得のみに使用し外部送信しない。外部 provider(AI を含む)への送信なし。
- 保持/アクセス: 本人のみ参照・更新可。削除は T-404 のユーザー削除フロー(`ON DELETE CASCADE`)に従う。メモを AI/analytics へ送る場合は将来の Spec で最小化と同意を定義する(本タスクでは送らない)。
- Data forbidden in logs: メモ、気分・難易度、request body、session、cookie、email。route に独自ログを追加しない。エラー応答に stack・SQL・DB エラー内容を含めない。
- IDOR/BOLA: DCI-INV-001(path に user を持たない)。CSRF: Origin 検証 + `Content-Type: application/json`。XSS: JSON のみを返し、メモは制御文字を拒否する(UI は表示時にエスケープする前提)。Injection: `$queryRaw` のタグ付きテンプレート(バインド変数のみ)。
- Abuse: メモ 1000 文字、body 16 KiB、対象日の範囲。Rate limit は Out of Scope(Accepted Risks)。

## AI Requirements

N/A。AI を利用しない。

## Observability and Operations

- Logs: route に独自ログを追加しない(構造化ログ基盤が未導入)。
- Metrics/Alerts: 既存方針(`docs/06`)の request count/error/latency に含まれる。専用 metric/alarm は追加しない。
- Runbook: 不要。
- Rollout/rollback: Feature Flag なし(新規 route のみ)。Migration なし。rollback はアプリの revert。

## Test Coverage Matrix

| Requirement | Unit                                                                                                      | Integration(実 PostgreSQL)                             | E2E                       |
| ----------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------- |
| DCI-001     | `upsertDailyCheckInUseCase`(fake: 作成/訂正/置換/再送)、handler の 200/401/403/413/415/422                | upsert の作成→更新、置換、再送、並行 6 件で 1 レコード | N/A(E2E 基盤導入後に追加) |
| DCI-002     | `resolveDailyCheckIn`(境界値 1/5/0/6、小数、メモ trim・空、全項目未設定)、契約 schema(メモ上限・制御文字) | DB の mood/difficulty CHECK(0/6 を拒否)                | N/A                       |
| DCI-003     | 範囲境界(今日・7 日前・8 日前・未来)、Asia/Tokyo の日付繰り上がり、DST 日、習慣なしでも可                 | -                                                      | N/A                       |
| DCI-004     | `getDailyCheckInUseCase`、handler の 200/404/422                                                          | 保存→取得の往復、他ユーザーのチェックインが 404        | N/A                       |
| DCI-INV-001 | repository 呼び出しに actor が必ず渡ることを fake で検証、handler が body の user 指定を拒否              | 他ユーザーの同日チェックインと混ざらない               | N/A                       |
| DCI-INV-002 | -                                                                                                         | 一意制約と ON CONFLICT、並行 upsert                    | N/A                       |

Fake/Stub 方針: Application の unit test は in-memory fake と固定 Clock、プロフィールは既存の fake。Integration は Testcontainers の実 PostgreSQL。fixture は架空データのみ。

## Open Questions

実装をブロックしない事項:

- **メモの文字数上限**: `docs/10` P2 が未決のため暫定 1000 文字。確定後に契約 schema の定数のみ更新する。
- **履歴・期間取得、WAU 集計**: T-204 で必要になった時点で Spec 化する。
- **過去に遡れる日数(7)**: T-202 と同じ暫定値。利用実態を見て定数のみ変更する。
- **チェックインの削除**: 要望が出た時点で別途検討する。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-10-03
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                             |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope。`docs/02` UC-10、`docs/09` T-203                                          |
| Specification        | Pass   | DCI-001〜004、DCI-INV-001〜005、State Transitions、Acceptance Criteria、Failure and Edge Cases。未決事項は非ブロック |
| Domain and Time      | Pass   | T-201 の `localDateAt` を使用、Clock 注入、timezone 変更・DST・日付境界を明記。冪等性・並行は ON CONFLICT            |
| API and Data         | Pass   | API and Events、Data and Migration(Migration なし、既存制約・index の確認、rollback)                                 |
| Security and Privacy | Pass   | Security and Privacy、Authorization Matrix(IDOR/CSRF/XSS/Injection/abuse、ログ禁止、入力上限、AI へ送らない)         |
| AI                   | N/A    | AI を利用しない                                                                                                      |
| Testing              | Pass   | Test Coverage Matrix。E2E は基盤未導入のため N/A と理由を明記                                                        |
| Operations           | Pass   | Observability and Operations(ログ方針、rollout/rollback)                                                             |
| Planning             | Pass   | [../plans/daily-check-in.md](../plans/daily-check-in.md)                                                             |

### Accepted Risks

- Rate limit 未実装(T-104/T-202 と同じ)。入力上限と対象日の範囲のみで抑える。
- `PUT` は後勝ち。古い画面からの訂正が別端末の入力を上書きしうる(日次入力の単純さを優先して楽観ロックは導入しない)。
- メモは健康に関わりうる自由記述だが、暗号化・マスキングは行わない(DB の保存時暗号化は infra 側の方針に従う)。
- 構造化ログ未導入のため、本 API 固有の運用ログ/metric は追加しない。
