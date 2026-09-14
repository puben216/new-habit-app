# ADR-004: Next.js Hosting

Status: accepted
Date: 2026-09-13

Context:
Next.js server（standalone）のホスティング候補は ECS Fargate + ALB、または Vercel 等 PaaS。チームは AWS 運用経験があるが、初期段階の運用工数と月額コストは抑えたい。

Decision:
Next.js standalone server は ECS Fargate + ALB で稼働させる（[03-architecture.md](../03-architecture.md), [07-infrastructure.md](../07-infrastructure.md)）。ただし初期構成（dev、および本番稼働開始直後）は最小構成とする。

- 単一 AZ、固定 task 数（autoscaling なし）から開始する。
- Multi-AZ 化・autoscaling・RDS Proxy 導入は、実利用の負荷実績を見てから追加する。

Alternatives considered:

- Vercel 等 PaaS: デプロイ・スケーリングは簡単だが、RDS/SQS/SES と別プロバイダにまたがるネットワーク構成（VPC peering や外部接続経路）が必要になり、[07-infrastructure.md](../07-infrastructure.md) のネットワーク方針との整合コストが高いため見送り。

Consequences:

- 初期構成は AZ 障害時に単一障害点となり、[01-product-requirements.md](../01-product-requirements.md) の RTO/RPO 目標（RPO 24h/RTO 4h）に対しダウンタイムが発生し得る。これは MVP 期間中の受容リスクとして明記する。
- 本番の高可用化（Multi-AZ、autoscaling）は T-502（Production infrastructure）着手時に判断し直す。

Security/operational impact:

- 最小構成であっても、Secrets Manager、暗号化、WAF、CloudWatch alarm 等の基本統制は省略しない（[07-infrastructure.md](../07-infrastructure.md)）。
- 単一 AZ 運用中の障害対応手順（手動 task 再作成、DB failover 確認）を runbook に明記する。

Review date: T-502（Production infrastructure）着手時に Multi-AZ / autoscaling 化を再評価する。
