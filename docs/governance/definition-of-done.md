# Definition of Done

## 目的

タスクを「コードを書いた」ではなく、安全にリリース・運用できる状態で完了させる。すべての変更は「設計 → 実装 → テスト → セルフレビュー」の順で進める。

## 1. Design

- [ ] 対象Spec、要件ID、Acceptance Criteriaを確認した
- [ ] 変更区分と実装前ゲートの適用範囲を確認した
- [ ] 既存コード、API、DB、イベント、infra、運用への影響を調査した
- [ ] 重要な技術判断をADRへ記録した
- [ ] Scope外の変更を混入させていない

## 2. Implementation

- [ ] TypeScript strictで型安全であり、原則`any`を使用していない
- [ ] DomainがUI、DB、外部API、frameworkへ直接依存していない
- [ ] 外部入力をruntime validationしている
- [ ] 認証と認可を分離し、操作単位で認可している
- [ ] 外部APIにtimeout、限定的なretry、error handling、fallbackがある
- [ ] Secretや環境固有値をコードへ記述していない
- [ ] DB変更には新しいMigrationがある
- [ ] ログへ個人情報、自由記述、Secret、tokenを出力していない

## 3. Testing

- [ ] 変更された業務ロジックにUnit Testを追加した
- [ ] DB、認可、外部境界の重要ケースにIntegration Testを追加した
- [ ] 主要ユーザーフローの変更にPlaywright E2Eを追加・更新した
- [ ] 正常系、異常系、境界値、権限拒否を確認した
- [ ] bug fixには修正前に失敗する回帰テストがある
- [ ] `format:check`、`lint`、`typecheck`、`test`、`build`が成功した
- [ ] flaky testや無条件skipを追加していない

## 4. Security and Operations

- [ ] 権限、PII、入力値、abuseの観点でセルフレビューした
- [ ] 必要なlog、metric、alarm、traceを追加・更新した
- [ ] 新しい失敗モードに対するユーザー表示と運用対応がある
- [ ] rollout、Feature Flag、rollback、Migration順序を確認した
- [ ] 必要なRunbookを追加・更新した
- [ ] dependency、container、IaCの検査結果に未対応の重大問題がない

## 5. Documentation and Review

- [ ] Specの要件IDとテストの対応が追跡できる
- [ ] API変更をOpenAPI、DB変更をDB設計へ反映した
- [ ] 仕様変更をプロダクト要件・機能Specへ反映した
- [ ] 重要判断をADRへ反映した
- [ ] 実装と文書に矛盾がない
- [ ] diff全体をセルフレビューした
- [ ] PRレビュー指摘を解決した

## 完了判定

- Standard: 全項目を適用。非該当はPRに理由を記録する
- Lightweight: 影響する項目のみ適用するが、回帰テスト、品質コマンド、セルフレビューは省略しない
- Emergency: 復旧を優先できるが、2営業日以内に不足するテスト・文書・原因分析を補う

すべての必須CIが成功し、Acceptance Criteriaを満たし、本番投入に必要な承認が完了した時点でDoneとする。
