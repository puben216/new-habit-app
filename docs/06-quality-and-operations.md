# 6. テスト戦略・CI/CD・運用

## テスト戦略

### Unit Test

対象: Domain と Application の分岐が多いルール。

- 予定機会生成（曜日、schedule version、タイムゾーン、DST）
- build/reduce の成功定義、ストリーク、継続率、skip、分母 0
- 習慣作成・編集の invariant
- AI 入出力 schema、fallback 選択、retry 判定
- 第三者コンテンツ validator、権利資料 allowlist、ブランド誤認防止、権利疑義時の fallback
- 認可 policy と状態遷移

外部 I/O を mock しすぎず、Clock/ID generator/Port を明示注入する。property-based test は日付・スケジュール集計に有効。

### Integration Test

Testcontainers 等で実 PostgreSQL を起動し、以下を確認する。

- migration の fresh apply と upgrade
- repository query、constraint、transaction、競合、idempotency
- user A が user B の public ID で読み書きできない
- SQS message schema と handler、部分失敗、重複配送
- AI/Email は fake HTTP server で timeout、429、5xx、不正 JSON を再現
- AI adapter は、転載・翻訳・文体模倣・提携誤認を誘発する出力を返す fake を用意し、拒否結果が保存・表示されないことを検証

### API Contract Test

- OpenAPI と runtime schema の一致
- status code、Problem Details、pagination cursor
- event payload と AI schema の後方互換性

### Playwright E2E

MVP の必須シナリオ:

1. 登録 → onboarding → build 習慣作成 → 当日成功記録
2. reduce 習慣作成 → 回避成功記録 → ダッシュボード反映
3. 記録訂正 → 集計更新
4. 週次レビュー → AI 成功案表示 → 選択適用
5. AI 障害 → fallback 表示、通常記録は継続可能
6. ログアウト/セッション期限切れ/他ユーザーリソース拒否
7. 通知 opt-in/out と設定変更
8. キーボード操作と主要な a11y assertion

外部サービスは staging 専用 fake/adapter を使い、決済やメール誤送信を避ける。E2E データは test run ごとに namespace を分離する。

## 品質ゲート

ローカルと CI で同じコマンドを使う。

```text
format:check
lint
typecheck
test:unit
test:integration
build
test:e2e (PR は主要 smoke、main/staging は全件)
```

カバレッジ率だけを目的化しない。Domain/Application の statement/branch threshold を設定し、重要シナリオ一覧との対応を PR template で確認する。flaky test は再試行で隠さず隔離・期限付き issue 化する。

## GitHub Actions

### Pull Request

- dependency lockfile、secret scan、SAST、license/dependency audit
- lint/typecheck/unit を並列実行
- PostgreSQL service で migration + integration
- production build
- preview/staging 環境で Playwright smoke（fork PR の secret 扱いに注意）
- Terraform fmt/validate/tflint/checkov 相当と plan（本番 apply は不可）

### Main

1. immutable artifact/container を build、SBOM 生成、脆弱性 scan
2. staging deploy、migration、smoke/E2E
3. 手動承認後、同一 artifact を production へ段階 deploy
4. backward-compatible migration を先行
5. health/metrics を監視し、失敗時はアプリを直前 revision へ rollback

OIDC で GitHub Actions から AWS role を引き受け、長期 AWS key を保存しない。環境別 approvals と branch protection を有効化する。

## 可観測性

- 構造化 JSON log: timestamp、level、service、environment、requestId/traceId、route/useCase、duration、result、errorCode
- 禁止: email、token、cookie、自由記述、AI prompt/response、Authorization header
- Metrics: request count/error/latency、DB pool、queue depth/age、DLQ、Lambda error/throttle、AI 成功/validation/fallback/latency/token/cost、通知 delivery
- AI の権利保護 metric は reason code ごとの拒否・human review・fallback 件数だけを記録し、問題となった入力文・出力文そのものはログへ記録しない
- Tracing: Next.js → DB/queue、Lambda → provider。OpenTelemetry は相関が不足した段階で導入し、まず requestId を一貫伝播
- Alarm: 5xx 比率、認証異常、DLQ > 0、oldest message age、AI fallback 急増、DB CPU/storage/connections、synthetic login failure
- Runbook: AI 障害、メール停止、DB 接続枯渇、migration failure、認証障害、削除要求失敗

## リリース・運用

- feature flag で AI provider/model/prompt version と新機能を段階投入
- backup と point-in-time recovery を有効化し、四半期ごとに restore drill
- dependency update を定期化し、major update は設計判断と回帰テストを伴う
- インシデントは severity、owner、communication、timeline、postmortem を定義
