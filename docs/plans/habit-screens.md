# 習慣管理画面 Implementation Plan

Status: Ready
責任者: TBD
最終更新: 2026-10-09
Spec: [../specs/habit-screens.md](../specs/habit-screens.md)
変更区分: Standard

## 方針

Presentation の追加のみ(Domain/Application/API は変更しない)。純粋ロジックを `lib/habits/` に切り出して Unit で検証し、画面は薄く保つ。

1. **lib/habits**: `date.ts`(`todayInTimezone(now, tz)`)、`form.ts`(`HabitFormValues`、`validateHabitForm`、`toCreateBody`、`toUpdateBody(habit, values, today)`(変更項目のみ。変更なしは `null`))、`labels.ts`(種別・曜日の要約)、`messages.ts`(`describeHabitError`: 固定文言、`conflict`/`archived`/`notFound` の分類)、`habits-api.ts`(型付き client: list/get/create/update/archive)。
2. **features/habits**: `HabitList`(`useInfiniteQuery`)、`HabitForm`(作成・編集共通。`DaysOfWeekField`(fieldset+checkbox)、種別 radio、`ConflictNotice`)、`HabitDetail`(取得、編集、アーカイブ確認)。
3. **route**: `(app)/(onboarded)/habits/page.tsx`、`habits/new/page.tsx`、`habits/[habitId]/page.tsx`。nav に「習慣」。
4. **E2E**: `habits.spec.ts`。helper は既存を再利用。
5. **文書**: `docs/09` の T-214。

## 影響分析

| 領域         | 変更                          | リスク                                   |
| ------------ | ----------------------------- | ---------------------------------------- |
| Presentation | 画面 3、フォーム、client、nav | 中(フォームが大きい。純粋ロジックで検証) |
| その他       | なし                          | なし                                     |

## インターフェースと契約

- `toCreateBody(values, today): CreateHabitRequest`、`toUpdateBody(habit, values, today): UpdateHabitRequest | null`、`describeHabitError(error): { fields, form, kind }`。
- 型付き client は `@habit-app/contracts` の schema を使う。

## データMigration

N/A。

## セキュリティレビュー

- 認可は API。XSS は React エスケープ。`version` を必ず送り、競合時に自動で再送しない。

## テスト計画

| 要件        | テスト種別  | 予定テスト                                                                                           |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| HUI-002     | Unit(+性質) | `todayInTimezone`(任意の時刻・主要 timezone で YYYY-MM-DD、UTC との差が最大 1 日)、検証、create body |
| HUI-003/004 | Unit        | `toUpdateBody`(変更項目のみ・変更なし null・スケジュール変更検出)、エラー分類と固定文言              |
| 全体        | E2E         | Spec 受け入れ基準の全シナリオ                                                                        |

3 観点: fast-check、手動変異(update body、検証、エラー分類、日付)、実装後の敵対的審査。

## 展開と運用

Feature Flag 不要。ロールバック: revert。

## タスク分解

1. lib/habits と Unit。2. 画面・フォーム・route・nav。3. E2E。4. 文書と全品質コマンド。

## 依存関係

先行: T-104、T-211〜T-213(完了済み)。

## リスク

| リスク                               | 対策                                     | 責任者 |
| ------------------------------------ | ---------------------------------------- | ------ |
| Domain の 422 の項目名が想定と異なる | E2E で遡及拒否・必須違反を実際に確認する | TBD    |

## 着手条件

- [x] Spec が Ready / ADR-010 Accepted / API・Migration は N/A / 認可方針レビュー済み / テスト環境 / 依存 task 完了 / rollback 方針 / ゲート全項目 Pass または N/A
