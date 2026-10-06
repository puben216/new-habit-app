# Schedule Calculation Implementation Plan

Status: Done
責任者: TBD
最終更新: 2026-10-03
Spec: [../specs/schedule-calculation.md](../specs/schedule-calculation.md)
変更区分: Standard

## 方針

`packages/domain/src/habits/` に、`Date` と `Intl` のみに依存する純粋関数を追加する。暦日は既存の `YYYY-MM-DD` 文字列表現(`calendar-date.ts`)を唯一の表現とし、暦日演算は `Date.UTC` で行う(ローカル timezone の `Date` 演算を使わないため DST の影響を受けない)。`localDateAt` のみ `Intl.DateTimeFormat`(`en-CA`、`timeZone` 指定、`formatToParts`)で壁時計の年月日を取り出す。

- `calendar-date.ts` に `dayOfWeekOf`/`addCalendarDays` を追加する(既存の `previousCalendarDate` は `addCalendarDays(date, -1)` へ寄せ、重複を持たない。外部への振る舞いは変えない)。
- `local-date.ts` に `localDateAt` を追加する。
- `occurrence.ts` に `resolveScheduleForDate`、`scheduledOccurrenceOn`、`generateOccurrences`、`MAX_OCCURRENCE_RANGE_DAYS` を追加する。`habit.ts` の `findScheduleVersionForDate` は `resolveScheduleForDate` へ委譲する(重複実装を避ける)。
- `week.ts` に `weekStartOf` を追加する。`weekStartsOn` は identity の `isWeekStartsOn` と同一の値域だが、habits から identity へ依存させないため、habits 側では 0〜6 の整数検証を自前で行う(両者は仕様上同一の番号付けであり、型の共有は将来の整理対象)。
- エラーは `HabitDomainError` 階層に `InvalidScheduleCalculationInputError` を追加する。
- timezone の検証は `identity` の `parseTimezone` を再利用せず、`localDateAt` 内で `Intl` の `RangeError` を捕捉して `InvalidScheduleCalculationInputError` に変換する(habits → identity 依存を作らない。`lint:boundaries` の module 境界を確認する)。

## 影響分析

| 領域           | 変更                                                                            | リスク                     |
| -------------- | ------------------------------------------------------------------------------- | -------------------------- |
| Domain         | `habits/` に関数とエラーを追加。`findScheduleVersionForDate` が新関数へ委譲する | 低(既存テストが回帰を検知) |
| Application    | 変更なし(T-202 が利用する)                                                      | N/A                        |
| Infrastructure | 変更なし                                                                        | N/A                        |
| Presentation   | 変更なし                                                                        | N/A                        |
| Database       | 変更なし                                                                        | N/A                        |
| API/Event      | 変更なし                                                                        | N/A                        |
| AWS/Terraform  | 変更なし                                                                        | N/A                        |
| Observability  | 変更なし                                                                        | N/A                        |

## インターフェースと契約

`@habit-app/domain` から追加で `export` する。

- 型: `ScheduledOccurrence { date, targetCount, effectiveFrom }`、`OccurrenceRange { from, to }`
- 定数: `MAX_OCCURRENCE_RANGE_DAYS`(366)
- 関数: `localDateAt`、`dayOfWeekOf`、`addCalendarDays`、`resolveScheduleForDate`、`scheduledOccurrenceOn`、`generateOccurrences`、`weekStartOf`
- エラー: `InvalidScheduleCalculationInputError`

`dayOfWeekOf`/`addCalendarDays` は `calendar-date.ts` の内部ヘルパーだが、T-202/T-204 が使うため公開する(`index.ts` に追加)。

## データMigration

- Expand/Backfill/Switch/Contract: N/A。DB スキーマ変更なし。
- ロールバック/前方修正: 本 PR の revert で完結する(他モジュールから未参照。`findScheduleVersionForDate` の委譲は既存テストで同値性を確認する)。

## セキュリティレビュー

- 認証/認可: N/A(Domain は認可を扱わない)。
- 個人情報/Secret/ログ: N/A。テスト fixture は架空の日付・timezone のみ。
- 悪用対策: 列挙範囲の上限(366 日)で過大な計算を防ぐ。

## テスト計画

| 要件   | テスト種別 | 予定テスト                                                                                                                                                                                                |
| ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-001 | Unit       | `local-date.test.ts`: Asia/Tokyo の日付繰り上がり、America/New_York の 2026-03-08(春)/2026-11-01(秋)DST 前後、Pacific/Kiritimati と Pacific/Pago_Pago、UTC、不正 Date/timezone                            |
| SC-002 | Unit       | `calendar-date.test.ts`: 既知日の曜日(2026-01-04=日 等)、月/年/うるう日またぎ、負数、不正日付                                                                                                             |
| SC-003 | Unit       | `occurrence.test.ts`: 期間内/外、無期限、境界日、重複で例外、`findScheduleVersionForDate` との同値                                                                                                        |
| SC-004 | Unit       | `occurrence.test.ts`: 対象/非対象曜日、版切替日、旧版最終日                                                                                                                                               |
| SC-005 | Unit       | `occurrence.test.ts`: 昇順、両端を含む、from>to、366/367 日、空の版。性質テスト(依存追加なしの決定論的疑似乱数で多数の版・範囲を生成し、`scheduledOccurrenceOn` の全日走査との一致、昇順、重複なしを検証) |
| SC-006 | Unit       | `week.test.ts`: weekStartsOn=0〜6 の各値、週またぎ、年またぎ、不正値                                                                                                                                      |

property test には新規依存(fast-check)を追加せず、シード固定の疑似乱数で再現可能にする(依存追加は audit・保守コストが増えるため、必要性が出た時点で別途判断する)。

## 展開と運用

- Feature Flag: 不要(未使用の純粋関数の追加のみ)。
- デプロイ順序: 制約なし。T-202 より先に merge する。
- メトリクス/アラーム: 不要。
- ロールバック条件と手順: 問題発生時は commit を revert する。

## タスク分解

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. `calendar-date.ts` に `dayOfWeekOf`/`addCalendarDays` を追加 + Unit Test
3. `local-date.ts`(`localDateAt`)+ Unit Test(DST/日付変更線)
4. `occurrence.ts`(解決/判定/列挙)+ Unit Test + 性質テスト、`findScheduleVersionForDate` の委譲
5. `week.ts`(`weekStartOf`)+ Unit Test
6. `errors.ts`/`index.ts` の公開 API 整理
7. 品質コマンド(`format:check`/`lint`/`lint:boundaries`/`typecheck`/`build`/`test:unit`)の実行
8. roadmap(`docs/09-roadmap.md`)の T-201 更新、セルフレビュー、PR 作成

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行 task: T-103(完了)、T-102(完了。timezone と `week_starts_on` の定義)。
- ADR 依存、外部権限、provider: なし。

## リスク

| リスク                                                                              | 対策                                                                                         | 責任者 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| `Intl` の timezone データが実行環境で異なり、DST 境界のテストが環境依存になる       | テストは確定済みの過去/近未来の規則(2026 年の米国 DST 等)のみを使い、CI(Node 固定)で実行する | TBD    |
| `findScheduleVersionForDate` の委譲で、重複版の扱いが「先頭を返す」から例外に変わる | Habit 集約は重複を作れないため実運用の影響はない。委譲後も既存テストを通すことで確認する     | TBD    |
| T-202 が timezone 変更時の挙動に追加要件を出す                                      | Spec の方針(保存済み local_date は変えない)を T-202 Spec で再確認する                        | TBD    |

## 着手条件

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(該当ADRなし、Domain 実装のみのためN/A)
- [x] API/event契約がレビュー済み、またはN/A(契約なし)
- [x] Migration方針がレビュー済み、またはN/A(migrationなし)
- [x] 認可・データ保護方針がレビュー済み(N/A、Domainは認可を扱わない)
- [x] テスト環境とFake/Stubを準備できる(Vitestのみで完結、外部依存なし)
- [x] 依存taskが完了している(T-102、T-103 完了済み)
- [x] rollout/rollback方針が決定している(通常のcommit revertで十分)
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
