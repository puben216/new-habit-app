# Change Classification

## 目的

変更のリスクに応じて必要なSpec、Plan、レビュー、テストを選び、過剰な文書化と不十分な検証の両方を避ける。

## Standard

### 対象

- 新機能、業務ルール、状態遷移の追加・変更
- 公開API、イベント、AI schemaの追加・破壊的変更
- DB schema、認証・認可、個人情報、Secret、IAMの変更
- 非同期処理、外部provider、課金、通知の変更
- 複数moduleやdeployment unitにまたがる変更

### 必須成果物

- Feature Spec
- Implementation Plan
- Implementation Readiness Gate合格
- 必要に応じてADR、OpenAPI、Migration、Runbook
- Unit/Integration/E2Eのうち影響に応じたテスト

## Lightweight

### 対象

- 既存Spec内の局所的なbug fix
- 表示文言、スタイル、アクセシビリティの局所改善
- 外部契約や業務ルールを変えない小規模refactoring
- 開発者向けtoolingや文書修正

### 必須成果物

- IssueまたはPRに問題、Scope、Acceptance Criteriaを記載
- 影響範囲の確認
- bug fixの回帰テスト、またはテスト不要理由
- lint/typecheck/test/buildのうち該当する品質ゲート
- セルフレビュー

変更中にStandard条件が見つかった場合は作業を止め、Standardへ再分類する。

## Emergency

### 対象

- 本番停止、重大なデータ破損、active exploit、Secret漏洩への緊急対応
- 即時対応しない場合にユーザーまたは事業への重大な影響が続く変更

### 進め方

1. Incident IDと責任者を明記する
2. 最小かつreversibleな修正、Feature Flag無効化、rollbackを優先する
3. 可能な範囲のtargeted testとpeer reviewを行う
4. 変更と判断を監査可能に記録する
5. 2営業日以内に回帰テスト、Spec/ADR/Runbook、postmortemを補完する

「期限が厳しい」「変更が小さい」はEmergencyの理由にならない。

## 判定表

| 質問                                             | Yesの場合       |
| ------------------------------------------------ | --------------- |
| 新しいユーザー価値や業務ルールか                 | Standard        |
| API/DB/auth/PII/AI tool/infra securityを変えるか | Standard        |
| 複数moduleやdeploy順序へ影響するか               | Standard        |
| 既存Specどおりに戻す局所bug fixか                | Lightweight候補 |
| 文言・文書・内部整理だけか                       | Lightweight候補 |
| 重大な本番影響を今すぐ止める必要があるか         | Emergency       |

迷う場合はStandardとして扱う。分類と理由はIssueまたはPlan冒頭へ記録する。
