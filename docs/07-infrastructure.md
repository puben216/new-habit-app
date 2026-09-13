# 7. AWS・Terraform 構成案

## AWS 構成

### Edge / Web

- Route 53: DNS
- ACM: TLS certificate
- CloudFront: CDN、security headers、静的 asset cache
- AWS WAF: managed rules、rate-based rule
- ALB + ECS Fargate: Next.js standalone server。Lambda Web Adapter より常時アプリの挙動が予測しやすい
- ECR: signed/immutable container image

### Data / Secrets

- RDS PostgreSQL Multi-AZ（production）、暗号化、automated backup、PITR
- RDS Proxy は接続数を計測して必要なら導入。Lambda concurrency は DB pool 上限と連動
- Secrets Manager: DB credential、AI/Email provider secret
- KMS: RDS/SQS/Secrets/log の暗号鍵
- S3: export、一時成果物、ALB/WAF log。Block Public Access と lifecycle を設定

### Async / Notification

- SQS standard queues: `ai-coaching`, `notifications`, `account-deletion`
- 各 queue に DLQ、redrive、message retention、暗号化
- Lambda: queue consumer。reserved concurrency で DB/provider を保護
- EventBridge Scheduler: ユーザーごとの schedule を大量作成せず、一定間隔で対象 window を抽出して SQS へ投入
- SES: domain verification、DKIM/SPF/DMARC、bounce/complaint 処理

### Security / Operations

- Auth.js（NextAuth）: session は RDS 上の adapter table に永続化（Cognito user pool は不使用）。email verification、パスワード reset は自前実装。admin role は別途 TOTP 2FA を追加実装（[ADR-001](adr/ADR-001-authentication.md)）
- CloudWatch Logs/Metrics/Alarms/Dashboards、X-Ray または ADOT は必要時
- CloudTrail、GuardDuty、Security Hub（環境・費用に応じ段階導入）
- SNS: alarm 通知先

## Network

- production VPC は 2 AZ 以上
- public subnet: ALB/NAT（必要な場合）
- private app subnet: ECS/Lambda
- isolated data subnet: RDS
- RDS security group は app/worker security group からのみ許可
- AWS service は VPC endpoint を優先し、NAT cost と外向き通信面を削減
- AI provider への outbound は NAT 経由。将来 egress proxy/allowlist を検討

## 環境分離

- `dev`, `staging`, `prod` は原則 AWS account を分離。少なくとも state、VPC、DB、secret、IAM role を完全分離
- production への人手アクセスは SSO + MFA + short-lived role
- 本番データを staging にコピーしない。必要なら匿名化 pipeline を用意

## Terraform 構成

```text
infra/
├── modules/
│   ├── network/
│   ├── edge/
│   ├── web-service/
│   ├── database/
│   ├── queue-worker/
│   ├── identity/
│   ├── email/
│   ├── observability/
│   └── github-oidc/
└── environments/
    ├── dev/
    ├── staging/
    └── prod/
```

- root module は composition のみ、再利用単位を modules に置く
- provider/version と module source version を pin、lockfile を commit
- remote state は環境別 S3 + versioning + encryption。state lock は利用する backend の現行推奨方式を実装時に確認
- secret value を Terraform state に入れず、Secrets Manager の器だけを作り値は別の安全な投入経路で設定
- default tags、命名規約、cost allocation tags を locals で統一
- `prevent_destroy` を production DB/state 等へ設定。ただし復旧手順もテストする
- plan は PR artifact、apply は protected environment + approval、drift detection を定期実行
- Policy as Code で public DB/S3、平文通信、過剰 IAM、暗号化なしを拒否

## 概算・スケーリング方針

最初から高可用構成をすべて dev に複製せず、production のみ Multi-AZ、dev は最小構成と停止戦略を採る。ボトルネックは DB connections と AI latency/cost が先に来る想定なので、ECS task/Lambda concurrency、pool size、SQS batch size を一体で capacity planning する。
