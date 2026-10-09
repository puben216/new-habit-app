# 今日の記録とチェックイン画面 Implementation Plan

Status: Ready
責任者: TBD
最終更新: 2026-10-09
Spec: [../specs/today-screens.md](../specs/today-screens.md)
変更区分: Standard

## 方針

1. **Application**: `getScheduleOnDateUseCase(deps, { actorUserId, date })` を追加。範囲検証は upsert と共有するヘルパー `assertEntryDateInRange`(`ENTRY_BACKDATE_LIMIT_DAYS`)へ切り出す。`TodaySchedule` に `earliestDate` を追加し、`getTodayScheduleUseCase` は同じ組み立て関数を使う。
2. **Contracts**: `todayScheduleResponseSchema` に `earliestDate` を追加(同じ schema を `schedule/{date}` にも使う)。
3. **Presentation(API)**: `entry-handlers.ts` に `scheduleOnDate`、`app/api/v1/schedule/[date]/route.ts`、`entry-container.ts` に use case を追加。
4. **lib/today**: `dates.ts`(`buildDateOptions(today, earliest)`: 昇順の日付列と相対ラベル、`parseSelectedDate(raw, options)`)、`entry-actions.ts`(操作 → body、表示ラベル)、`check-in.ts`(検証・body)、`messages.ts`(固定文言とエラー分類)、`today-api.ts`(型付き client)。
5. **features/today**: `DateTabs`、`HabitRecordCard`、`TodayView`、`CheckInForm`。`/today` page を置き換え(`searchParams.date` を渡す)。
6. **E2E**: `today.spec.ts`(習慣は API で作成。Origin を付ける)。
7. **文書**: `docs/05`(新規 GET と `earliestDate`)、`docs/09`。

## 影響分析

| 領域         | 変更                                      | リスク                                         |
| ------------ | ----------------------------------------- | ---------------------------------------------- |
| Application  | use case 追加、`TodaySchedule` に項目追加 | 低(既存テストを更新)                           |
| Contracts    | 応答 schema に `earliestDate`             | 低(追加のみ)                                   |
| Presentation | handler・route 追加、画面                 | 中(日付と状態の組み合わせ。Unit と E2E で確認) |
| Database     | なし                                      | なし                                           |

## インターフェースと契約

- `GET /api/v1/schedule/{date}` → `TodayScheduleResponse`(`earliestDate` を含む)。
- `buildDateOptions(today, earliestDate)`、`parseSelectedDate(raw, options)`、`entryBodyFor(kind, action, quantity?)`、`toCheckInBody(values)`。

## データMigration

N/A。

## セキュリティレビュー

- 新規 GET は認証必須、repository が actor 条件、範囲外は 422。応答に内部 ID を含めない(既存と同じ)。メモは文字として描画。

## テスト計画

| 要件    | 種別        | 予定テスト                                                                                                        |
| ------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| TUI-005 | Unit        | use case: 範囲境界(今日/7 日前/8 日前/未来)、予定判定、他ユーザー、`earliestDate`、timezone。handler: 401/422/200 |
| TUI-001 | Unit(+性質) | `buildDateOptions`: 長さ、連続性、先頭=earliest、末尾=today(性質)。`parseSelectedDate`                            |
| TUI-003 | Unit        | 操作 → body(reduce に quantity なし)、エラー分類                                                                  |
| TUI-004 | Unit        | チェックイン検証・body                                                                                            |
| 全体    | E2E         | Spec 受け入れ基準                                                                                                 |

3 観点: fast-check、手動変異、実装後の敵対的審査。

## 展開と運用

Feature Flag 不要。ロールバック: revert(応答拡張は後方互換)。

## タスク分解

1. Application/Contracts/handler/route と Unit。2. lib/today と Unit。3. 画面。4. E2E。5. 文書と全品質コマンド。

## 依存関係

先行: T-202、T-203、T-211〜T-214(完了済み)。

## リスク

| リスク                                     | 対策                                     | 責任者 |
| ------------------------------------------ | ---------------------------------------- | ------ |
| 既存テストが `earliestDate` の追加で壊れる | 期待値を更新し、追加であることを確認する | TBD    |

## 着手条件

- [x] Spec が Ready / ADR-010 Accepted / API 契約レビュー済み(TUI-005)/ Migration N/A / 認可方針 / テスト環境 / 依存 task 完了 / rollback 方針 / ゲート全項目 Pass または N/A
