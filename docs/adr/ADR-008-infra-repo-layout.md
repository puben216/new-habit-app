# ADR-008: Terraform Repository Layout

Status: accepted
Date: 2026-09-13

Context:
`infra/`（Terraform）をアプリケーションと同じモノレポに置くか、別リポジトリへ分離するかを検討した（[03-architecture.md](../03-architecture.md)）。MVP 段階ではチーム規模が小さく、SQS キュー追加のようにインフラ変更とアプリ変更（consumer コード）を同時に必要とするケースが多い。

Decision:
`infra/` は当面モノレポ内に同居させる（[03-architecture.md](../03-architecture.md) のディレクトリ構成のとおり）。インフラとアプリの変更を 1 つの PR でレビューできることを優先する。

Alternatives considered:
- 別リポジトリへ分離: 本番 AWS 権限を持つ CI/レビュアーをアプリ開発者から明確に分離できる、リリースサイクルを独立させられる利点はあるが、現状のチーム規模ではリポジトリ間の調整コストが利点を上回ると判断し見送り。

Consequences:
- fork PR にインフラ用の secret / OIDC 権限を渡さない運用を CI 側で担保する必要がある（[T-005](../09-roadmap.md) の懸念と対応）。アプリ PR 用 CI とインフラ適用用 CI のジョブ・権限は分離する。
- チームが分業体制になる、またはインフラの変更管理を厳格化したい場合は、`git subtree split` 等で `infra/` を別リポジトリへ切り出すことを再検討する。

Review date: チーム体制変更時、または T-502（Production infrastructure）着手時に再評価する。
