# ADR-002: ORM / Migration

Status: accepted
Date: 2026-09-13

Context:
モジュラーモノリスでは repository port の内側にのみ ORM の詳細を閉じ込めるため、選定の影響範囲は infrastructure 層に限定される（[03-architecture.md](../03-architecture.md)）。候補は Prisma、Drizzle、Kysely 等の query builder 直利用。

Decision:
ORM/migration ツールとして Prisma を採用する。schema は `packages/infrastructure/database` 配下で一元管理し、生成された Prisma Client は repository 実装からのみ参照する。Application/Domain 層は Prisma の型を直接 import しない。

Alternatives considered:

- Drizzle: 型推論と軽量さは優位だが、エコシステム/ドキュメントの厚みで Prisma に劣ると判断し見送り。
- Kysely 等 query builder 直利用: SQL に近い制御力はあるが、migration 管理を自前で組む必要があり MVP 速度を優先し見送り。

Consequences:

- Prisma Client 生成を CI パイプライン（型チェック・build 前）に組み込む。
- N+1 やクエリ性能は Prisma のクエリ設計に沿ってチューニングする。

Security/operational impact:

- migration 用 DB ロールと runtime 用 DB ロールを分離する（[07-infrastructure.md](../07-infrastructure.md)）。
- DB 接続 secret は Secrets Manager 経由でのみ注入し、リポジトリに平文を置かない。

Review date: 本番負荷試験（T-504）実施時にクエリ性能を再評価する。
