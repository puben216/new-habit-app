# Schedule Calculation Spec

Status: Ready
Owner: TBD
Last updated: 2026-10-03
Change classification: Standard
Roadmap Task: T-201

## Goal

習慣の ScheduleVersion 群とユーザーの IANA timezone から、「ユーザーのローカル日」を基準にした予定機会(その日にその習慣を実施する予定があるか、目標回数はいくつか)を決定論的に求める純粋な Domain 関数を提供する。これにより T-202(today query、entry upsert)以降が、timezone/DST/バージョン切替の扱いを再実装せず再利用できる。

## Success Metrics

- 予定機会の判定・生成がすべて Unit Test で検証されている(`pnpm test:unit` green)。DST 切替日、年・月・うるう日の境界、ScheduleVersion の切替日を含む。
- Domain が React/Next.js/Prisma/DB/HTTP に依存しない(`pnpm lint:boundaries` green)。`Date` と `Intl` 以外の実行時依存を持たず、現在時刻を内部で取得しない(Clock に依存しない)。
- 同一入力に対して常に同一出力を返す(参照透過)ことをテストで確認している。

## Scope

- 時刻(`Date`)と IANA timezone からローカル暦日(`YYYY-MM-DD`)を求める `localDateAt`。
- 暦日からの曜日(0=日〜6=土)算出と、暦日の加算(`addCalendarDays`)。
- ScheduleVersion 群と暦日から、その日に適用される版を決める解決(有効期間・曜日・目標回数)。
- 暦日範囲 `[from, to]` に対する予定機会の列挙 `generateOccurrences`。
- 週開始日(`week_starts_on`)に基づく、暦日を含む週の開始日算出 `weekStartOf`(T-204 の週次集計が利用する)。

## Out of Scope

- `HabitEntry`(実施記録)の保存、today query、upsert、冪等性(T-202)。
- reduce の `quantity` 意味論の確定。本 Spec の関数は `quantity` を扱わない(目標回数 `targetCount` を返すのみ)ため影響しない。T-202 着手前に確認する。
- `local_time`(実行時刻)を伴う通知の時刻計算、DST の存在しない時刻・重複時刻の解決(T-402。T-401 は時刻をローカル時刻のまま保存するだけ)。
- ストリーク/成功率などの集計(T-204)。
- Application 層の Clock port、ユーザー timezone の取得、API/DB。
- ユーザーが timezone を変更した場合の過去記録の再解釈(下記「Failure and Edge Cases」の方針のみ定める)。

## Actors and Preconditions

| Actor                     | Preconditions                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Application 層(T-202以降) | Clock port から得た `Date` と、Profile に保存済みの検証済み IANA timezone を渡す。認可は呼び出し側。 |

## Functional Requirements

### SC-001 ローカル暦日の算出

- `localDateAt(instant, timezone)` は、`instant` を `timezone` で解釈したときの暦日を `YYYY-MM-DD` で返す。
- DST の有無にかかわらず、ローカル暦日の境界は timezone の壁時計の 0 時で決まる(UTC 24 時間単位ではない)。
- `instant` が不正な `Date`(`NaN`)、または `timezone` が `parseTimezone` で受理されない場合は `InvalidScheduleCalculationInputError` を投げる。

### SC-002 暦日演算

- `dayOfWeekOf(date)` は 0(日)〜6(土)を返す。`daysOfWeek` の定義(`ScheduleVersion`)と同一の番号付けである。
- `addCalendarDays(date, days)` は暦日を `days` 日(負数可)進めた暦日を返す。月・年・うるう日をまたいで正しい。
- いずれも実在しない暦日を受けた場合は `InvalidScheduleCalculationInputError` を投げる。

### SC-003 ScheduleVersion の解決

- `resolveScheduleForDate(versions, date)` は `effectiveFrom <= date <= effectiveTo`(`effectiveTo` が null なら無期限)を満たす版を返す。該当なしなら `null`。
- 有効期間は重複しない前提(Habit 集約が保証)だが、重複を検出した場合は `OverlappingScheduleVersionError` を投げる(黙って先頭を選ばない)。
- 既存の `findScheduleVersionForDate` と同じ結果を返す。重複実装を避けるため、本関数は既存関数へ委譲するか、既存関数を本関数の薄いラッパーにする(Plan 参照)。

### SC-004 予定機会の判定

- `scheduledOccurrenceOn(versions, date)` は、`date` に適用される版があり、かつ `dayOfWeekOf(date)` がその版の `daysOfWeek` に含まれる場合に `{ date, targetCount, effectiveFrom }` を返す。そうでなければ `null`。
- 版の切替日(新版の `effectiveFrom` 当日)は新版の `daysOfWeek`/`targetCount` で判定する。旧版の最終日(`effectiveTo`)は旧版で判定する。

### SC-005 予定機会の列挙

- `generateOccurrences(versions, { from, to })` は、`from` から `to` まで(両端を含む)の各暦日について SC-004 を適用し、予定機会のみを日付昇順で返す。
- `from > to` の場合は空配列を返す。
- 範囲が `MAX_OCCURRENCE_RANGE_DAYS`(= 366 日、両端を含む日数)を超える場合は `InvalidScheduleCalculationInputError` を投げる(過大な計算とレスポンスを防ぐ入力上限)。
- 版が空配列でも空配列を返す。

### SC-006 週の開始日

- `weekStartOf(date, weekStartsOn)` は、`date` を含む週の開始暦日を返す。`weekStartsOn` は 0〜6(`week_starts_on` と同一の番号付け)。
- `weekStartsOn` が 0〜6 の整数でない場合は `InvalidScheduleCalculationInputError` を投げる。

## Business Rules and Invariants

- 予定機会は「ローカル暦日」に対する概念であり、時刻や UTC の瞬間には紐づかない。したがって DST による 23/25 時間日であっても、1 暦日につき予定機会は高々 1 件である。
- 「今日」は常に `localDateAt(clock.now(), profile.timezone)` で決める。暦日の加減算は `Date` の UTC 時刻演算ではなく暦日演算(`addCalendarDays`)で行い、DST の影響を受けない。
- 予定機会の判定は版の有効期間と `daysOfWeek` のみで決まり、`status`(active/archived)には依存しない。アーカイブ後に予定機会を表示するか否かは Application 層の判断とする。
- 関数は副作用を持たず、現在時刻・乱数・環境に依存しない(`localDateAt` は `Intl` の timezone データのみに依存する)。
- 返却値は `Object.freeze` した不変オブジェクト/配列とする。

## State Transitions

N/A。本 Spec の関数は状態を持たない。

## Acceptance Criteria

```gherkin
Scenario: DST 切替日のローカル暦日
  Given timezone が America/New_York
  When 2026-03-08T06:59:59Z(スプリングフォワード直前)と 2026-03-08T07:00:00Z を localDateAt に渡す
  Then 前者は 2026-03-08、後者も 2026-03-08 を返す
  And 2026-03-09T03:59:59Z は 2026-03-08、2026-03-09T04:00:00Z は 2026-03-09 を返す

Scenario: UTC の日付とローカル日付がずれる
  Given timezone が Asia/Tokyo
  When 2026-01-31T15:00:00Z を localDateAt に渡す
  Then 2026-02-01 を返す

Scenario: 曜日が予定に含まれる日だけ機会になる
  Given daysOfWeek=[1,3,5]、effectiveFrom=2026-01-01、effectiveTo=null の版
  When 2026-01-05(月)から 2026-01-11(日)を generateOccurrences に渡す
  Then 2026-01-05、2026-01-07、2026-01-09 の 3 件を昇順で返す

Scenario: バージョン切替日は新版で判定する
  Given 版A(2026-01-01〜2026-01-31、daysOfWeek=[1]、targetCount=1)と版B(2026-02-01〜、daysOfWeek=[0]、targetCount=3)
  When 2026-01-31(土)から 2026-02-02(月)を generateOccurrences に渡す
  Then 2026-02-01(日)のみ { targetCount: 3 } で返す(1/31 は版Aの対象曜日でなく、2/2 は版Bの対象曜日でない)

Scenario: 有効期間外は機会にならない
  Given effectiveFrom=2026-03-01 の版
  When 2026-02-27 から 2026-03-02 を渡す
  Then effectiveFrom より前の日は含まれない

Scenario: 範囲の上限
  Given 367 日にまたがる範囲
  When generateOccurrences を呼ぶ
  Then InvalidScheduleCalculationInputError が投げられる

Scenario: 週の開始日
  Given 2026-01-07(水)
  When weekStartOf を weekStartsOn=1(月)で呼ぶ
  Then 2026-01-05 を返す
  And weekStartsOn=0(日)では 2026-01-04 を返す
```

## Authorization Matrix

N/A。Domain はアクター/権限を扱わない。ownership と認可は T-202 の Application 層が、`actor user ID` を含むクエリで担保する。

## API and Events

N/A。本 Spec は Domain のみを対象とする。API/イベント契約は T-202 で確定する。

## Data and Migration

- Migration なし。スキーマは変更しない。`habit_schedule_versions`(`effective_from`/`effective_to`/`days_of_week`/`target_count`)と `user_profiles.timezone`/`week_starts_on` を読み取り元として想定するのみ。
- 暦日は `date`(timezone なし)、timezone は IANA ID という `docs/04-database-design.md` の方針(D-06)をそのまま適用する。

## Failure and Edge Cases

- `Date` が不正(`NaN`)、timezone が不正 → `InvalidScheduleCalculationInputError`。
- 範囲 `from`/`to` が実在しない暦日、または 366 日超 → `InvalidScheduleCalculationInputError`。
- `from > to` → 空配列(エラーにしない)。
- DST 切替日(23/25 時間日)、年末年始、うるう日(2024-02-29)、月末 → ローカル暦日と暦日演算が正しい。
- 日付変更線をまたぐ timezone(`Pacific/Kiritimati` UTC+14、`Pacific/Pago_Pago` UTC-11)で UTC 日付とずれる。
- 日付を丸ごと飛ばす/重複する timezone 変更(例: 2011-12-30 の `Pacific/Apia`)では、その日に対応する暦日が存在しない。`localDateAt` は ICU が返す暦日をそのまま返し、補正しない(実用上の影響が極めて小さいため、補正を設けない)。
- ユーザーが timezone を変更した場合、保存済みの `local_date` は変更せず、以降の「今日」のみが新 timezone で決まる。過去の予定機会は暦日と版だけで決まるため再計算しても変わらない。変更直後に同じ暦日が 2 回/0 回現れうる点は T-202 の today query で許容する(Spec 外の未決事項ではなく、本 Spec の方針とする)。
- 版が空、全版が範囲外 → 空配列。

## Security and Privacy

- Data collected: なし(純粋関数)。
- Data sent externally: なし。
- Data forbidden in logs: N/A(Domain はログを出力しない)。timezone/暦日は個人情報とはみなさないが、呼び出し側は習慣名等の自由記述と併せてログに出さない。
- Threats and controls: 入力上限(範囲 366 日)で過大計算を防ぐ。IDOR/認可は Application 層の責務。

## AI Requirements

N/A。AI を利用しない。

## Observability and Operations

- Logs/Metrics/Alerts: N/A(Domain はログ・メトリクスを持たない)。
- Runbook: N/A。
- Rollout/rollback: 未参照の純粋関数の追加のみで、既存機能へ影響しない。ロールバックは commit の revert で完結する。

## Test Coverage Matrix

| Requirement | Unit                                                                                                            | Integration | E2E |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ----------- | --- |
| SC-001      | UTC/ローカルのずれ、DST 前後、日付変更線付近、不正入力(`local-date.test.ts`)                                    | N/A         | N/A |
| SC-002      | 曜日の既知値、月/年/うるう日またぎ、負数、不正日付(`calendar-date.test.ts`)                                     | N/A         | N/A |
| SC-003      | 期間内/外、無期限、境界日、重複検出(`occurrence.test.ts`)                                                       | N/A         | N/A |
| SC-004      | 対象曜日/非対象曜日、版切替日、旧版最終日(`occurrence.test.ts`)                                                 | N/A         | N/A |
| SC-005      | 昇順、両端を含む、from>to、上限超過、空の版、性質テスト(全日走査との一致、昇順、重複なし)(`occurrence.test.ts`) | N/A         | N/A |
| SC-006      | 週開始日の各値、週またぎ、年またぎ、不正値(`week.test.ts`)                                                      | N/A         | N/A |

Integration/E2E は、これらを利用する T-202(today query、entry upsert)で追加する。

## Open Questions

- **reduce の `quantity` 意味論**: 本 Spec は `quantity` を扱わないため実装をブロックしない。T-202(Habit entry)の Spec 作成前に確認する。
- **`Pacific/Apia` 型の暦日欠落への補正**: 現状は補正しない方針(上記)。対象ユーザーが現れた場合に見直す。

いずれも実装をブロックしない。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-10-03
Reviewed by: —

| Gate                 | Result | Evidence                                                                                 |
| -------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope、ロードマップ T-201                            |
| Specification        | Pass   | SC-001〜SC-006、Acceptance Criteria、Failure and Edge Cases。Open Questions は非ブロック |
| Domain and Time      | Pass   | 暦日基準、Clock 非依存、DST は `Intl` による壁時計 0 時境界、timezone 変更の方針を明記   |
| API and Data         | Pass   | DB/API 変更なし(Data and Migration 節)                                                   |
| Security and Privacy | Pass   | 永続化・送信・ログなし、入力上限(366 日)あり。認可は T-202                               |
| AI                   | N/A    | AI を利用しない                                                                          |
| Testing              | Pass   | Test Coverage Matrix、境界値・性質テスト                                                 |
| Operations           | N/A    | Domain のみの変更でログ/メトリクス/Runbook の対象外                                      |
| Planning             | Pass   | `docs/plans/schedule-calculation.md`                                                     |

### Accepted Risks

- `Intl` の timezone データは実行環境の ICU に依存する。Node のバージョンにより新しい IANA 改定の反映が異なりうる。DST 規則改定時の日付は環境差でずれる可能性があるが、`parseTimezone` が同じ ICU で検証済みの ID のみを受け入れるため、未知 ID による不整合は起きない。
