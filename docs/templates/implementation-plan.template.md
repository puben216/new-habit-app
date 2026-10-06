# <Feature Name> Implementation Plan

Status: Draft
責任者: TBD
最終更新: YYYY-MM-DD
Spec: <relative link>
変更区分: Standard

## 方針

<Specを実現する実装方針。要件を繰り返さず、変更方法を書く>

## 影響分析

| 領域           | 変更 | リスク |
| -------------- | ---- | ------ |
| Domain         |      |        |
| Application    |      |        |
| Infrastructure |      |        |
| Presentation   |      |        |
| Database       |      |        |
| API/Event      |      |        |
| AWS/Terraform  |      |        |
| Observability  |      |        |

## インターフェースと契約

- <追加・変更するport、DTO、API、event、AI schema>

## データMigration

- Expand:
- Backfill:
- Switch:
- Contract:
- ロールバック/前方修正:

N/Aの場合は理由を記載する。

## セキュリティレビュー

- 認証/認可:
- 個人情報/Secret/ログ:
- 悪用対策:

## テスト計画

| 要件 | テスト種別           | 予定テスト |
| ---- | -------------------- | ---------- |
| <ID> | Unit/Integration/E2E | <case>     |

## 展開と運用

- Feature Flag:
- デプロイ順序:
- メトリクス/アラーム:
- ロールバック条件と手順:

## タスク分解

1. <独立してレビュー・検証できるtask>
2. <task>

各taskは「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- <先行task、外部権限、provider、ADR>

## リスク

| リスク | 対策 | 責任者 |
| ------ | ---- | ------ |
|        |      |        |

## 着手条件

- [ ] Spec StatusがReady
- [ ] 必須ADRがAccepted
- [ ] API/event契約がレビュー済み、またはN/A
- [ ] Migration方針がレビュー済み、またはN/A
- [ ] 認可・データ保護方針がレビュー済み
- [ ] テスト環境とFake/Stubを準備できる
- [ ] 依存taskが完了している
- [ ] rollout/rollback方針が決定している
- [ ] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
