# 8. セキュリティ上の注意点

## 脅威モデルの主要対象

- IDOR/BOLA による他ユーザーの習慣・記録・レビュー閲覧
- session theft、credential stuffing、account enumeration
- XSS/CSRF、自由記述を通じた stored XSS
- AI prompt injection、過剰な tool 実行、不正/危険な助言
- secret 漏洩、ログや telemetry への個人情報混入
- 管理画面の権限昇格と内部不正
- queue の重複・改ざん・replay、通知の誤送信
- dependency/supply-chain と CI credential 侵害

## 認証・認可

- 認証は IdP、認可は Application policy として分離
- すべての user resource query に actor user ID を含め、取得後チェックだけに依存しない
- Admin は別 role/group、MFA 必須、通常 UI/API と route/permission を分離
- sensitive action（email変更、export、削除）は再認証
- login/rate limit、generic error、session rotation/revocation を実装
- service role は queue ごとに最小権限。migration role と runtime role を分ける

## Web/API

- TLS only、HSTS、CSP、frame-ancestors、nosniff、Referrer-Policy
- output escaping を基本とし、user/AI HTML を描画しない。Markdown が必要なら厳格 sanitize
- cookie session の状態変更は CSRF token/origin validation
- body/文字列/配列/ページサイズ上限、content type 検証
- CORS は必要な origin のみ。エラーに stack、SQL、provider response を含めない
- abuse rate limit を actor/IP/endpoint 別に設計

## AI Safety

- AI 入力内のユーザーテキストを命令ではなく data として区切る
- tool allowlist、read-only、引数 schema、認可、timeout、call count 上限
- 自動 DB 更新や通知送信をモデルに許可しない
- 出力 schema、長さ、URL、危険表現を検証し、不正時は破棄
- 医療・メンタルヘルスの診断や断定を避ける。高リスク兆候は定型 safety response と専門支援案内へ切替
- prompt/model/schema version と結果 status は監査するが、機微な本文を通常ログに残さない
- AI/RAGへ投入する第三者資料は権利根拠と用途を確認したallowlistに限定し、出所不明資料や無許諾の書籍本文・翻訳・図表を利用しない
- 第三者コンテンツの再現、著者の文体模倣、ブランドの公式・提携・監修誤認を prompt と決定論的な出力validatorの双方で防ぐ
- 権利疑義のある出力はユーザーへ表示・永続化せず、安全な定型fallbackへ切り替える。判定対象本文をlogやanalyticsへ送らない

## データ保護

- データ分類: account identifier、習慣/自由記述、認証情報、運用 metadata
- at rest/in transit encryption。secret は Secrets Manager、ローカルは `.env`（commit 禁止）
- email 等の検索が必要な値は正規化・アクセス制限。ログ相関には user public ID ではなく rotate 可能な pseudonymous ID
- retention: app data、AI result、audit、backup、export を個別定義。削除要求が backup と provider にどう反映されるか明文化
- S3 export は短期限 presigned URL、暗号化、lifecycle、自分の object のみ

## 管理・監査

- 管理画面に習慣本文やレビュー本文を既定表示しない。サポート上必要な場合のみ理由・期限付き elevation
- admin action は append-only audit。actor、目的、対象、時刻、request ID を記録
- break-glass role は通常無効、利用時 alarm、事後レビュー
- 脆弱性報告窓口、incident response、credential rotation、breach assessment を用意

## Secure SDLC チェック

- threat model を主要機能ごとに更新
- secret scan、SAST、dependency/SBOM/container/IaC scan
- branch protection、CODEOWNERS（auth、DB、infra）、review 必須
- lockfile 固定、GitHub Actions を commit SHA pin、OIDC short-lived credential
- 認可 integration test と tenant isolation test をリリース必須にする
