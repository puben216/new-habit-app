# <Feature Name> Spec

Status: Draft
責任者: TBD
最終更新: YYYY-MM-DD
変更区分: Standard
ロードマップ項目: <T-XXX、または該当なしの理由>

## 目的

<解決するユーザー課題と提供価値>

## 成功指標

- <測定可能な指標と成功基準>

## 範囲

- <含めるもの>

## 対象外

- <含めないもの>

## アクターと前提条件

| アクター   | 前提条件 |
| ---------- | -------- |
| <アクター> | <条件>   |

## 機能要件

### <PREFIX>-001 <要件名>

- <外部から観測可能な振る舞い>

## 業務ルールと不変条件

- <常に成立すべき規則>

## 状態遷移

| 現在の状態 | 操作   | 次の状態 | 拒否される条件 |
| ---------- | ------ | -------- | -------------- |
| <状態>     | <操作> | <状態>   | <条件>         |

## 受け入れ基準

```gherkin
Scenario: <name>
  Given <precondition>
  When <action>
  Then <observable result>
```

## 認可マトリクス

| 操作   | Guest | Member | Admin | 所有権ルール       |
| ------ | ----: | -----: | ----: | ------------------ |
| <操作> |    No |    Yes |    No | 自分のリソースのみ |

## APIとイベント

- <OpenAPI/event schemaへのリンク、またはN/A理由>

## データとMigration

- <table、constraint、index、retention、migration、またはN/A理由>

## 失敗・境界ケース

- <timeout、競合、重複、空状態、境界値>

## セキュリティとプライバシー

- 収集データ:
- 外部送信データ:
- ログ禁止データ:
- 脅威と対策:

## AI要件

- <入力、出力schema、tool、validation、fallback、eval、またはN/A理由>

## 可観測性と運用

- ログ:
- メトリクス:
- アラート:
- Runbook:
- 展開/ロールバック:

## テスト対応表

| 要件         | Unit       | Integration | E2E        |
| ------------ | ---------- | ----------- | ---------- |
| <PREFIX>-001 | <case/N/A> | <case/N/A>  | <case/N/A> |

## 未決事項

- <実装前に解決する問い。なければ「なし」>

## 実装準備状況

Status: Not Ready
Reviewed at: —
Reviewed by: —

| Gate                 | Result | Evidence |
| -------------------- | ------ | -------- |
| Product              | Fail   |          |
| Specification        | Fail   |          |
| Domain and Time      | Fail   |          |
| API and Data         | Fail   |          |
| Security and Privacy | Fail   |          |
| AI                   | N/A    |          |
| Testing              | Fail   |          |
| Operations           | Fail   |          |
| Planning             | Fail   |          |

### 受容リスク

なし
