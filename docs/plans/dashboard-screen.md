# ダッシュボード画面 Implementation Plan

Status: Ready
責任者: TBD
最終更新: 2026-10-10
Spec: [../specs/dashboard-screen.md](../specs/dashboard-screen.md)
変更区分: Standard

## 方針

Presentation のみ。`lib/dashboard/`(`format.ts`: `formatRate`、`formatPeriod`、`streakText`。`dashboard-api.ts`: 型付き client と query key)、`features/dashboard/`(`DashboardView`、`WindowSummary`、`HabitStatsRow`)、`app/(app)/(onboarded)/dashboard/page.tsx`、nav に「ダッシュボード」。T-215 の記録成功時に `["dashboard"]` を無効化する。

## 影響分析

| 領域         | 変更                              | リスク |
| ------------ | --------------------------------- | ------ |
| Presentation | 画面 1、整形、nav、T-215 の無効化 | 低     |
| その他       | なし                              | なし   |

## インターフェースと契約

`formatRate(rate: number | null): string`、`formatPeriod(from, to): string`、`streakText(current, longest): string`。

## データMigration

N/A。

## セキュリティレビュー

認可は API。習慣名は React のエスケープ。

## テスト計画

| 要件    | 種別        | 予定テスト                                                                                           |
| ------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| DSH-002 | Unit(+性質) | `formatRate`: 境界(0/1/0.995/0.004/null)、性質(100% は 1 のときだけ、0% は 0 のときだけ、単調非減少) |
| 全体    | E2E         | Spec 受け入れ基準                                                                                    |

3 観点: fast-check、手動変異、敵対的審査。

## 展開と運用

Feature Flag 不要。revert。

## タスク分解

1. lib/dashboard と Unit。2. 画面・nav・無効化。3. E2E。4. 文書と全品質コマンド。

## 依存関係

先行: T-204、T-211〜T-215(完了済み)。

## リスク

| リスク                       | 対策                                              | 責任者 |
| ---------------------------- | ------------------------------------------------- | ------ |
| E2E の日付依存で不安定になる | profile の timezone(Asia/Tokyo)の日付で組み立てる | TBD    |

## 着手条件

- [x] Spec が Ready / ADR-010 Accepted / API・Migration は N/A / 認可方針 / テスト環境 / 依存 task 完了 / rollback 方針 / ゲート全項目 Pass または N/A
