# ADR-005: Email 配送

Status: accepted（region/ドメインは open follow-up）
Date: 2026-09-13

Context:
MVP の通知は email のみ（PRD FR-10）。送信サービス自体は AWS 統合の観点から SES が既定候補だが、送信ドメインは未取得、送信 region も未確定の状態。

Decision:
通知配送サービスとして Amazon SES を採用する。region はレイテンシと運用簡便性を考慮し ap-northeast-1（東京）を第一候補とするが、送信ドメイン取得・DKIM/SPF/DMARC 設定・sandbox 解除は個別タスクとして T-401（Notification preferences）着手前までに完了させる。ドメイン確定までの dev/staging 検証は SES sandbox の verified test address で行う。

Alternatives considered:
- SendGrid 等サードパーティ ESP: AWS 外の追加ベンダー依存が増えるため見送り。

Consequences:
- ドメイン取得・region 確定が遅れた場合、T-401/T-402 の着手がブロックされる。ドメイン取得は本 ADR 成立後に担当者と期限を決めて別途トラッキングする。
- sandbox 解除には AWS サポートへの申請と送信実績の説明が必要になるため、本番リリース前にリードタイムを確保する。

Security/operational impact:
- bounce/complaint 処理、配信停止（unsubscribe）、rate limit は T-401/T-402 で設計する（[07-infrastructure.md](../07-infrastructure.md)）。
- 送信ドメインの DKIM/SPF/DMARC 設定を必須とし、なりすまし送信を防止する。

Review date: 送信ドメイン確定時。遅くとも T-401 着手前に region/ドメインを確定し本 ADR を更新する。
