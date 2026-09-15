# Habit Domain Spec

Status: Ready
Owner: TBD
Last updated: 2026-09-15
Change classification: Standard
Roadmap Task: T-103

## Goal

`build`(身につけたい習慣)と `reduce`(減らしたい習慣)の中核業務ルールを、DB/HTTP/フレームワークに依存しない純粋な Domain モデル(`Habit`、`HabitKind`、`ScheduleVersion`)として定義する。これにより T-104(repository/use case/API)以降のすべての層が、同じ不変条件を再実装せず再利用できる。

## Success Metrics

- `Habit`/`HabitKind`/`ScheduleVersion` の不変条件がすべて Unit Test で検証されている(`pnpm test:unit` green)。
- Domain が React/Next.js/Prisma/DB/HTTP のいずれにも依存しない(`pnpm lint:boundaries` green、`packages/domain` に該当パッケージへの import が存在しない)。
- T-104 が repository/use case を実装する際、本 Spec に定義された関数・型をそのまま再利用できる(新たな業務ルールの再実装が不要)。

## Scope

- `HabitKind`("build" | "reduce")の型と実行時ガード。
- `ScheduleVersion` 値オブジェクトの生成・検証(`effectiveFrom`/`effectiveTo`/`daysOfWeek`/`targetCount`)。
- `Habit` 集約エンティティ(`id`/`kind`/`name`/`purpose`/`cue`/`minimumAction`/`replacementAction`/`status`/`scheduleVersions`)の生成・詳細更新・アーカイブ・スケジュール変更。
- 上記に付随する不変条件: kind 不変性、reduce の targetCount=1 固定、daysOfWeek の値域・非空・重複禁止、ScheduleVersion 有効期間の重複禁止、スケジュール編集時の既存有効開始日の保持。
- build/reduce の日次成功判定の純粋関数(`isTargetMet`: `quantity >= targetCount`)。

## Out of Scope

- Repository 実装、永続化、トランザクション、DB マッピング(T-104)。
- `HabitEntry`(実施記録)エンティティそのもの、予定機会生成、ストリーク/成功率集計(T-201/T-202/T-204、`tracking` モジュール)。
- ID(`public_id` 等)の生成方式、楽観ロック用 `version` 列の管理(Application/Infrastructure、T-104)。
- API/HTTP 契約、認可、cursor pagination(T-104)。
- 文字数上限等、値域が未決の入力検証(`docs/10-decisions-and-open-questions.md` P2)。

## Actors and Preconditions

| Actor                     | Preconditions                                                       |
| ------------------------- | ------------------------------------------------------------------- |
| Application 層(T-104以降) | Domain の公開関数(`createHabit`等)経由でのみ Habit を生成・変更する |

Domain 自体はエンドユーザーやHTTPアクターを直接扱わない。

## Functional Requirements

### HD-001 HabitKind の定義

- `HabitKind` は `"build" \| "reduce"` のみを許可する。
- `isHabitKind`/`assertHabitKind` により実行時にも検証できる。

### HD-002 Habit の作成

- `createHabit(input)` は `id`、`kind`、`name`/`purpose`/`cue`/`minimumAction`(必須、空文字不可)、`replacementAction`(任意)、`initialSchedule` を受け取り、`status: "active"` の `Habit` を返す。
- `initialSchedule` は `createScheduleVersion` と同じ検証を通る。

### HD-003 Habit 詳細の更新

- `updateHabitDetails(habit, changes)` は `name`/`purpose`/`cue`/`minimumAction`/`replacementAction` のみを更新できる。
- `kind` は `UpdateHabitDetailsInput` の型に存在せず、コンパイル時に更新不可能である。
- アーカイブ済み Habit の更新は拒否する。

### HD-004 Habit のアーカイブ

- `archiveHabit(habit)` は `status` を `"archived"` にする。既にアーカイブ済みの場合は同じ内容を返す(冪等)。

### HD-005 ScheduleVersion の生成と検証

- `createScheduleVersion(kind, input)` は次を検証する。
  - `effectiveFrom`/`effectiveTo` は実在する暦日(`YYYY-MM-DD`)であり、`effectiveTo` が非 null の場合は `effectiveFrom` 以降であること。
  - `daysOfWeek` は 0〜6 の整数からなる空でない配列であり、重複を含まないこと。
  - `targetCount` は正の整数であること。
  - `kind === "reduce"` の場合、`targetCount` は必ず 1 であること。

### HD-006 ScheduleVersion の重複禁止

- `assertNoOverlappingScheduleVersions(versions)` は、同一 Habit に属する ScheduleVersion 群の有効期間([effectiveFrom, effectiveTo])が互いに重複する場合にエラーを投げる。

### HD-007 スケジュール変更(有効開始日の保持)

- `changeSchedule(habit, input)` は新しい ScheduleVersion を追加する。
  - 新しい `effectiveFrom` と重なる既存の ScheduleVersion があれば、その `effectiveFrom` は変更せず、`effectiveTo` のみを新版の前日に設定して「閉じる」。
  - 新しい `effectiveFrom` がいずれかの既存版の `effectiveFrom` 以前の場合は `UnsupportedScheduleChangeError` を投げる(遡及編集は本 Spec の対象外)。
  - アーカイブ済み Habit への適用は拒否する。

### HD-008 成功判定

- `isTargetMet(scheduleVersion, quantity)` は `quantity >= scheduleVersion.targetCount` を返す。

## Business Rules and Invariants

- 習慣は `build` または `reduce` であり、作成後に変更できない。
- `build` は 1 日の目標回数(targetCount)を複数許容し、成功は `quantity >= targetCount`。
- `reduce` は MVP では `targetCount = 1` に固定する。
- `daysOfWeek` は 0(日)〜6(土)の範囲、空でない、重複しない。
- 同一 Habit 内で ScheduleVersion の有効期間は重複しない。
- スケジュール変更は既存版の `effectiveFrom` を書き換えず、新しい有効開始日から新版を追加する。

## State Transitions

| Current  | Action             | Next     | Rejected when                                         |
| -------- | ------------------ | -------- | ----------------------------------------------------- |
| (none)   | createHabit        | active   | kind不正、必須項目が空、初期scheduleが不正            |
| active   | updateHabitDetails | active   | 更新後の値が不正                                      |
| active   | archiveHabit       | archived | (なし。常に成功、既にarchivedなら冪等)                |
| archived | updateHabitDetails | -        | 常に拒否(HabitArchivedError)                          |
| archived | changeSchedule     | -        | 常に拒否(HabitArchivedError)                          |
| active   | changeSchedule     | active   | 遡及編集、reduceでtargetCount≠1、有効期間重複、値域外 |

## Acceptance Criteria

```gherkin
Scenario: buildの成功判定
  Given targetCountが3のScheduleVersion
  When quantityが3
  Then isTargetMetはtrueを返す

Scenario: buildの未達成
  Given targetCountが3のScheduleVersion
  When quantityが2
  Then isTargetMetはfalseを返す

Scenario: reduceの成功判定
  Given targetCountが1に固定されたreduceのScheduleVersion
  When quantityが1
  Then isTargetMetはtrueを返す

Scenario: kindの不変性
  Given buildとして作成されたHabit
  When updateHabitDetailsを呼び出す
  Then kindフィールドは型として存在せず更新できない
  And Habitオブジェクトはfreezeされ直接代入もTypeErrorになる

Scenario: reduceでtargetCountを1以外にする
  Given kind=reduceのHabitまたはScheduleVersion入力
  When targetCountに1以外を指定してcreateScheduleVersionまたはchangeScheduleを呼ぶ
  Then InvalidScheduleVersionErrorが投げられる

Scenario: スケジュール編集で有効開始日を保持する
  Given effectiveFrom=2024-01-01, effectiveTo=nullのScheduleVersionを持つHabit
  When effectiveFrom=2024-04-01の新しいスケジュールへ変更する
  Then 既存版のeffectiveFromは2024-01-01のまま、effectiveToが2024-03-31に設定される
  And 新版はeffectiveFrom=2024-04-01として追加される

Scenario: 有効期間の重複を拒否する
  Given effectiveFrom=2024-01-01, effectiveTo=2024-04-01のScheduleVersion
  When effectiveFrom=2024-03-01の新しいScheduleVersionを同じHabitへ追加しようとする
  Then OverlappingScheduleVersionErrorが投げられる

Scenario: daysOfWeekの値域違反を拒否する
  Given daysOfWeekに7または-1を含む入力
  When createScheduleVersionを呼び出す
  Then InvalidScheduleVersionErrorが投げられる
```

## Authorization Matrix

N/A。Domain はアクター/権限を扱わない。認可は Application 層(T-104)の責務。

## API and Events

N/A。本 Spec は Domain のみを対象とし、API/イベント契約は T-104 で確定する。

## Data and Migration

- Migration なし。本 Spec は `packages/infrastructure/database/schema.prisma`(`Habit`/`HabitScheduleVersion`)に対応する概念モデルを Domain として定義するのみで、スキーマ自体は変更しない。
- Domain の値域(daysOfWeekの範囲、targetCount>0)は、既存の T-004 CHECK 制約と整合させてある。
- `reduce` の `targetCount=1` 固定は、04-database-design.md の「実装時の補足」ではDB trigger ではなく Application 層(T-104)での検証としているが、本 Spec では Domain の `Habit`/`ScheduleVersion` 集約内(`createScheduleVersion`/`changeSchedule`)で検証する设計とした。理由は Decisions 節を参照。DB 側に追加の CHECK/trigger は導入しない(既存方針を変更しない)。

## Failure and Edge Cases

- `daysOfWeek` が空、範囲外、重複 → `InvalidScheduleVersionError`
- `targetCount` が 0 以下または非整数 → `InvalidScheduleVersionError`
- `reduce` で `targetCount !== 1` → `InvalidScheduleVersionError`
- `effectiveTo < effectiveFrom` → `InvalidScheduleVersionError`
- `effectiveFrom`/`effectiveTo` が実在しない暦日(例: 2024-02-30) → `InvalidScheduleVersionError`
- ScheduleVersion 有効期間の重複 → `OverlappingScheduleVersionError`
- 遡及的なスケジュール編集(新effectiveFromが既存版のeffectiveFrom以前) → `UnsupportedScheduleChangeError`
- アーカイブ済みHabitへの更新/スケジュール変更 → `HabitArchivedError`
- 不正なkind → `InvalidHabitKindError`
- name/purpose/cue/minimumAction が空文字 → `InvalidHabitDetailsError`

## Security and Privacy

- Data collected: なし(Domainは永続化・送信を行わない純粋関数/エンティティ)。
- Data sent externally: なし。
- Data forbidden in logs: N/A(Domain自体はログ出力を行わない)。
- Threats and controls: N/A。IDOR/認可/Secretの扱いはApplication/Infrastructure層(T-104)の責務。

## AI Requirements

N/A。本SpecはAIを利用しない。

## Observability and Operations

- Logs/Metrics/Alerts: N/A(Domainはログ・メトリクスを持たない。呼び出し元のApplication層がエラーを監視する)。
- Runbook: N/A。
- Rollout/rollback: 新規パッケージ内モジュールの追加のみであり、既存機能への影響はない。ロールバックは当該コミットのrevertで完結する。

## Test Coverage Matrix

| Requirement | Unit                                                                    | Integration | E2E |
| ----------- | ----------------------------------------------------------------------- | ----------- | --- |
| HD-001      | 有効/無効なkindの判定(`habit-kind.test.ts`)                             | N/A         | N/A |
| HD-002      | build/reduce作成、必須項目の空文字拒否、id空文字拒否(`habit.test.ts`)   | N/A         | N/A |
| HD-003      | 更新、kind更新不可(型/実行時)、archived時拒否(`habit.test.ts`)          | N/A         | N/A |
| HD-004      | archive、冪等性(`habit.test.ts`)                                        | N/A         | N/A |
| HD-005      | daysOfWeek/targetCount/暦日の正常系・異常系(`schedule-version.test.ts`) | N/A         | N/A |
| HD-006      | 重複あり/なしの判定(`schedule-version.test.ts`)                         | N/A         | N/A |
| HD-007      | 有効開始日保持、遡及編集拒否(`habit.test.ts`)                           | N/A         | N/A |
| HD-008      | build/reduceの成功判定(`schedule-version.test.ts`)                      | N/A         | N/A |

Integration/E2EはT-104(repository/use case/API)以降で、実際の永続化・HTTP経路と合わせて追加する。

## Open Questions

- **reduceのquantity意味論**: `docs/04-database-design.md`は「buildの当日成功はquantity>=target_count」と明記するが、reduceのquantityが「対象行動を回避できた回数(1=回避成功)」を表すのか、「対象行動が発生した回数」を表すのかが `01-product-requirements.md`/`04-database-design.md` に明記されていない。本Spec/実装では`isTargetMet`をkindによらず同一の`quantity >= targetCount`公式として実装し、reduceでも`quantity=1`を成功として扱う前提を置いた。この前提はHabitEntry(tracking, T-201/T-202)のUI入力仕様・保存方式の確定と合わせて再確認が必要。
- **Habit `id`の型**: 本SpecはDomainの`id`をvalidationなしの非空文字列として扱う。UUID形式であることの検証やbrand型化が必要かは、T-104でのID発行方式(Application/Infrastructureがpublic_id UUIDを生成)確定時に見直す。
- **文字数上限**: `name`/`purpose`/`cue`/`minimumAction`/`replacementAction`の最大文字数は`10-decisions-and-open-questions.md`のP2で未決のため、Domainでは空文字のみを拒否し上限は設けていない。上限確定後にDomainへ追加する。

これらはいずれも実装をブロックしない(値が未決でもDomainの型・関数として動作するため)と判断し、Draft Specとして実装を進めた。

## Implementation Readiness

Status: Ready(Open Questionsは実装をブロックしないため)
Reviewed at: 2026-09-15
Reviewed by: Habit Domain 実装者(セルフレビュー)

| Gate                 | Result | Evidence                                                                               |
| -------------------- | ------ | -------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope                                              |
| Specification        | Pass   | HD-001〜HD-008、Acceptance Criteria、State Transitions。Open Questionsは実装非ブロック |
| Domain and Time      | Pass   | 暦日(calendar date)のみを扱いClockに依存しない設計、境界はArchitecture Rules準拠       |
| API and Data         | Pass   | Data and Migration節(migrationなし、既存CHECK制約との整合)                             |
| Security and Privacy | N/A    | Domainは永続化・送信・ログを行わない                                                   |
| AI                   | N/A    | AIを利用しない                                                                         |
| Testing              | Pass   | Test Coverage Matrix、`pnpm test:unit`で56件green                                      |
| Operations           | N/A    | Domainのみの変更でログ/メトリクス/Runbookの対象外                                      |
| Planning             | Pass   | `docs/plans/habit-domain.md`                                                           |

### Accepted Risks

- reduceのquantity意味論に関するOpen Questionが残る。T-104着手前に確認し、必要ならDomainのisTargetMetまたはHabitEntry設計を調整する。

### Open Questions

- 上記「Open Questions」節のとおり(reduceのquantity意味論、id型、文字数上限)。
