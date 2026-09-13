# Implementation Readiness Gate

## 目的

未確定の要件や見落とされた運用・セキュリティ要件を抱えたまま実装を開始しないための共通ゲートである。Standard 変更は、対象 Spec が本ゲートを通過して `Status: Ready` になるまで実装を開始しない。

チェック欄を埋めることではなく、判断の根拠へ追跡できることを合格条件とする。非該当項目には `N/A` と理由を記載する。

## 適用範囲

- Standard: 本ゲートをすべて適用する
- Lightweight: Product、Specification、Testing、Planning を必須とし、他項目は影響に応じて適用する
- Emergency: 事前ゲートを省略可能。ただし復旧後 2 営業日以内に事後レビューと必要な文書更新を行う

区分の定義は [`change-classification.md`](change-classification.md) を参照する。

## Gate 1: Product

- [ ] 解決するユーザー課題と期待する価値が定義されている
- [ ] MVPまたは承認済みロードマップに含まれている
- [ ] Scope / Out of Scope が明記されている
- [ ] 成功条件が観測・検証可能である
- [ ] 既存のプロダクト要件・用語との矛盾がない

## Gate 2: Specification

- [ ] 機能要件に一意なIDがある
- [ ] 正常系のAcceptance Criteriaがある
- [ ] 主要な異常系、境界値、空状態が定義されている
- [ ] 状態遷移と業務上の不変条件が定義されている
- [ ] 関連Spec、API、DB、UI、非同期処理への影響を確認した
- [ ] 実装を左右する未決事項が残っていない
- [ ] Specのレビュー担当者が承認した

## Gate 3: Domain and Time

- [ ] 業務用語と責務を既存Domain modelへ対応付けた
- [ ] Domain / Application / Infrastructure / Presentation の境界が明確である
- [ ] 状態変更の主体と許可条件が明確である
- [ ] 日付、時刻、タイムゾーン、DSTの扱いが明確である
- [ ] 冪等性、同時更新、重複処理の要否を判断した

## Gate 4: API and Data

- [ ] APIまたはイベントの入力、出力、エラー、versionが定義されている
- [ ] 認証・認可ルールが操作単位で定義されている
- [ ] DB変更の有無と影響範囲を確認した
- [ ] Migration、後方互換性、データ移行、削除方針が定義されている
- [ ] 制約、index、transaction、paginationの要否を確認した
- [ ] rollbackまたはforward-fix戦略が定義されている

## Gate 5: Security and Privacy

- [ ] 収集・保存・外部送信するデータを特定した
- [ ] 個人情報・機微情報の保持期間とアクセス範囲が明確である
- [ ] IDOR、権限昇格、XSS、CSRF、Injection、abuseを検討した
- [ ] Rate Limitと入力サイズ上限の要否を判断した
- [ ] ログ、メトリクス、traceに記録してはいけない情報を明記した
- [ ] Secretや権限に変更がある場合、最小権限とrotationを確認した

## Gate 6: AI（AI利用時のみ）

- [ ] AIを使う理由と決定論的実装では不足する理由が明確である
- [ ] AIに任せる判断と任せない判断が定義されている
- [ ] 入力最小化、prompt/schema/model versioningが定義されている
- [ ] Structured Outputとruntime validationが定義されている
- [ ] Toolのallowlist、引数検証、認可、呼出回数上限が定義されている
- [ ] Timeout、有限Retry、Fallback、DLQが定義されている
- [ ] Safety基準とoffline/production評価方法が定義されている
- [ ] ユーザー承認なしに設定やデータを変更しない

## Gate 7: Testing

- [ ] 要件IDとテスト種別の対応表がある
- [ ] Domain/ApplicationのUnit Test対象が定義されている
- [ ] DB、認可、外部境界のIntegration Test対象が定義されている
- [ ] 主要ユーザーフローのPlaywright E2E対象が定義されている
- [ ] 外部サービスのFake/Stub方針がある
- [ ] 失敗、timeout、retry、競合、重複のテスト方針がある
- [ ] fixtureに実在の個人情報やSecretを使用しない

## Gate 8: Operations

- [ ] 必要なlog、metric、trace、alarmを定義した
- [ ] Feature Flag、段階リリース、停止方法の要否を判断した
- [ ] rollbackとデータ整合性回復の方法が定義されている
- [ ] Runbook、サポート手順、管理画面変更の要否を判断した
- [ ] 費用、rate limit、capacityへの影響を確認した

## Gate 9: Planning

- [ ] 実装Planが存在し、対象Specへリンクしている
- [ ] 変更対象のmodule、interface、API、table、infrastructureを特定した
- [ ] 依存タスクと実行順序を特定した
- [ ] 各タスクが独立してレビュー・検証可能なサイズである
- [ ] rollout、migration、rollbackタスクが実装順に含まれている
- [ ] 必要な外部アカウント、権限、環境が利用可能である
- [ ] Planのレビュー担当者が承認した

## 判定記録

個別Specには次の形式で証跡を残す。

```markdown
## Implementation Readiness

Status: Ready
Reviewed at: YYYY-MM-DD
Reviewed by: <role or name>

| Gate | Result | Evidence |
|---|---|---|
| Product | Pass | 本SpecのGoal、Scope、Success Metrics |
| Specification | Pass | FR-001〜FR-006、Acceptance Criteria |
| Domain and Time | N/A | 日付・業務状態を扱わないため |
| API and Data | Pass | OpenAPI、Migration Plan |
| Security and Privacy | Pass | Security節、認可matrix |
| AI | N/A | AIを利用しないため |
| Testing | Pass | Test Coverage Matrix |
| Operations | Pass | Observability節 |
| Planning | Pass | 対応する実装Plan |

### Accepted Risks

- <承認した残存リスク。なければ「なし」>

### Open Questions

なし
```

## Gate結果

- `Pass`: 根拠があり、実装開始を妨げる問題がない
- `N/A`: 非該当理由が妥当である
- `Fail`: 未解決。Specは`Ready`にできない
- `Waived`: 期限、承認者、理由、追跡Issueがある例外。恒久的な省略には使用しない

`Fail`が1つでもある、または実装を左右するOpen Questionが残る場合は開始不可とする。
