# 通知設定画面 Implementation Plan

Status: Ready
責任者: TBD
最終更新: 2026-10-10
Spec: [../specs/notification-screen.md](../specs/notification-screen.md)
変更区分: Standard

## 方針

Presentation のみ。`lib/notifications/`(`settings.ts`: 値の型、`validateForm`、`toPutBody(saved, form)`(enabled を保つ)、`toggleBody(saved, enabled)`(保存済みの値だけを使う)、`describeNotificationError`、`statusLabel`、`notification-api.ts`)、`features/notifications/`(`NotificationsView`: 状態パネル+フォーム)、`app/(app)/(onboarded)/notifications/page.tsx`、nav に「通知」。タイムゾーン選択は T-213 の `buildTimezoneOptions` と `SelectField` を再利用する。停止/再開は T-215 と同じ ref ロック。

## 影響分析

| 領域         | 変更              | リスク |
| ------------ | ----------------- | ------ |
| Presentation | 画面 1、整形、nav | 低     |
| その他       | なし              | なし   |

## インターフェースと契約

`toPutBody(saved, form): UpsertNotificationSettingsRequest`(`enabled: saved.enabled`)、`toggleBody(saved, enabled)`、`validateForm(form): Partial<Record<Field, "required">>`、`describeNotificationError(error): { fields, form }`。

## データMigration

N/A。

## セキュリティレビュー

認可は API。表示は固定文言と時刻のみ。

## テスト計画

| 要件        | 種別 | 予定テスト                                                                                       |
| ----------- | ---- | ------------------------------------------------------------------------------------------------ |
| NUI-002/003 | Unit | body 組み立て(enabled 保持/反転、quiet hours null、保存済みの値のみ)、検証、エラー分類・固定文言 |
| 全体        | E2E  | Spec 受け入れ基準                                                                                |

3 観点: fast-check(body の往復・enabled 保持の性質)、手動変異、敵対的審査。

## 展開と運用

Feature Flag 不要。revert。

## タスク分解

1. lib/notifications と Unit。2. 画面・nav。3. E2E。4. 文書と全品質コマンド。

## 依存関係

先行: T-401、T-211〜T-216(完了済み)。

## リスク

| リスク                                  | 対策                                          | 責任者 |
| --------------------------------------- | --------------------------------------------- | ------ |
| `422` の fieldErrors キーが想定と異なる | E2E で実際の拒否(23:00)を確認し、マップを調整 | TBD    |

## 着手条件

- [x] Spec が Ready / ADR-010 Accepted / API・Migration は N/A / 認可方針 / テスト環境 / 依存 task 完了 / rollback 方針 / ゲート全項目 Pass または N/A
