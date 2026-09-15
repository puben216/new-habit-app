# Habit Domain Implementation Plan

Status: Done
Owner: TBD
Last updated: 2026-09-15
Spec: [../specs/habit-domain.md](../specs/habit-domain.md)
Change classification: Standard

## Approach

`packages/domain/src/habits/` 配下に、外部依存を持たない純粋な TypeScript モジュールとして `HabitKind`/`ScheduleVersion`/`Habit` を実装する。各モジュールは「値の生成と同時に不変条件を検証し、検証を通った不変(`Object.freeze`)なオブジェクトのみを返す」パターンに統一する。更新操作(`updateHabitDetails`/`archiveHabit`/`changeSchedule`)はすべて新しいオブジェクトを返す非破壊的(immutable)な純粋関数として実装し、呼び出し元(将来のApplication層)が参照透過性に頼って安全に扱えるようにする。

エラーはHabitDomainErrorを頂点とする専用の例外階層(`errors.ts`)で表現し、Application層(T-104)がこれをcatchしてHTTP/ユースケース固有のエラー型へ変換できるようにする。

## Impact Analysis

| Area           | Change                                                                  | Risk |
| -------------- | ----------------------------------------------------------------------- | ---- |
| Domain         | `packages/domain/src/habits/*` を新規追加。`src/index.ts`から re-export | 低   |
| Application    | 変更なし(T-104で本Domainを利用する)                                     | N/A  |
| Infrastructure | 変更なし                                                                | N/A  |
| Presentation   | 変更なし                                                                | N/A  |
| Database       | 変更なし(概念対応のみ確認、migrationなし)                               | N/A  |
| API/Event      | 変更なし                                                                | N/A  |
| AWS/Terraform  | 変更なし                                                                | N/A  |
| Observability  | 変更なし(Domainはログ・メトリクスを持たない)                            | N/A  |

## Interfaces and Contracts

新規公開API(`@habit-app/domain`から`export`):

- 型: `HabitKind`, `ScheduleVersion`, `ScheduleVersionInput`, `Habit`, `HabitStatus`, `HabitDetailsInput`, `CreateHabitInput`, `UpdateHabitDetailsInput`
- 関数: `isHabitKind`, `assertHabitKind`, `createScheduleVersion`, `closeScheduleVersion`, `scheduleVersionsOverlap`, `assertNoOverlappingScheduleVersions`, `isTargetMet`, `createHabit`, `updateHabitDetails`, `archiveHabit`, `changeSchedule`, `findScheduleVersionForDate`
- エラー: `HabitDomainError`, `InvalidHabitKindError`, `InvalidHabitDetailsError`, `InvalidScheduleVersionError`, `OverlappingScheduleVersionError`, `UnsupportedScheduleChangeError`, `HabitArchivedError`

T-104はこれらをrepository/use caseから直接利用し、DBの行⇄Domainオブジェクトのマッピングのみを追加する想定。

## Data Migration

- Expand/Backfill/Switch/Contract: N/A。DBスキーマ変更を伴わないため。
- Rollback/forward fix: 本PRのrevertのみで完結する(他モジュールから未参照のため)。

## Security Review

- Authentication/authorization: N/A(Domainは認可を扱わない)。
- PII/secrets/logging: N/A(Domainは永続化・ログ出力を行わない。テストのfixtureも架空の習慣名のみを使用)。
- Abuse controls: N/A。

## Test Plan

| Requirement | Test level | Planned test                                                                      |
| ----------- | ---------- | --------------------------------------------------------------------------------- |
| HD-001      | Unit       | `habit-kind.test.ts`: 有効/無効なkindの判定                                       |
| HD-002      | Unit       | `habit.test.ts`: build/reduce作成、必須項目空文字拒否、id空文字拒否、不正kind拒否 |
| HD-003      | Unit       | `habit.test.ts`: 詳細更新、kind型不可、archived時拒否                             |
| HD-004      | Unit       | `habit.test.ts`: archive、冪等性                                                  |
| HD-005      | Unit       | `schedule-version.test.ts`: daysOfWeek/targetCount/暦日の正常系・異常系           |
| HD-006      | Unit       | `schedule-version.test.ts`: 重複あり/なしの判定                                   |
| HD-007      | Unit       | `habit.test.ts`: 有効開始日保持、遡及編集拒否                                     |
| HD-008      | Unit       | `schedule-version.test.ts`: build/reduceの成功判定(isTargetMet)                   |

Integration/E2EはT-104で追加(本Planの対象外)。

## Rollout and Operations

- Feature Flag: 不要(未使用の新規Domainモジュールの追加のみで、既存の実行パスに影響しない)。
- Deployment order: 制約なし。T-104より先にmergeする。
- Metrics/alarms: 不要。
- Rollback trigger and procedure: 問題発生時は本PRのcommitをrevertする。他モジュールから未参照のため影響範囲はない。

## Task Breakdown

1. Feature Spec(`docs/specs/habit-domain.md`)作成、Implementation Readiness Gate自己評価
2. `HabitKind`実装 + Unit Test(`habit-kind.ts`/`.test.ts`)
3. 暦日ヘルパー実装 + Unit Test(`calendar-date.ts`/`.test.ts`、ScheduleVersionの内部実装用)
4. `ScheduleVersion`実装 + Unit Test(値域・reduce制約・重複検知・成功判定)
5. `Habit`集約実装 + Unit Test(作成・更新・アーカイブ・スケジュール変更・有効開始日保持)
6. `packages/domain/src/index.ts`からのpublic API re-export整理
7. 品質コマンド一式(`format:check`/`lint`/`lint:boundaries`/`typecheck`/`build`/`test:unit`)の実行と確認
8. Spec/Roadmapのステータス更新、PR作成

各taskは「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## Dependencies

- 先行task: T-001〜T-004(完了済み)。ADR依存なし。
- 外部権限/provider: 不要。

## Risks

| Risk                                                                       | Mitigation                                                                   | Owner |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----- |
| reduceのquantity意味論の前提が誤っている場合、T-201/T-202で手戻り          | Spec Open Questionとして明記し、T-104/tracking設計着手前に確認する           | TBD   |
| Habit集約がScheduleVersionsを内包する設計がT-104のrepository設計と食い違う | Interfaces and Contracts節でDomain公開APIを明示し、T-104着手時にレビューする | TBD   |

## Start Conditions

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(該当ADRなし、Domain実装のみのためN/A)
- [x] API/event契約がレビュー済み、またはN/A(本Planの対象外)
- [x] Migration方針がレビュー済み、またはN/A(migrationなし)
- [x] 認可・データ保護方針がレビュー済み(N/A、Domainは認可を扱わない)
- [x] テスト環境とFake/Stubを準備できる(Vitestのみで完結、外部依存なし)
- [x] 依存taskが完了している(T-001〜T-004完了済み)
- [x] rollout/rollback方針が決定している(通常のcommit revertで十分)
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
