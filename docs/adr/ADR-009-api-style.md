# ADR-009: API 方式

Status: accepted
Date: 2026-09-16

Context:
Web クライアントとバックエンドの通信方式として、REST + OpenAPI と tRPC を比較した。どちらも TypeScript モノレポと Next.js Route Handler で実装できる。tRPC は server の procedure 型を client へ直接公開でき、同一 TypeScript コードベース内での開発体験に優れる。一方、本システムは Web UI だけでなく、管理機能、非同期処理、将来の外部クライアントや運用ツールからも利用できる、実装言語に依存しない契約を必要とする。また、HTTP status、header、cache、冪等性、楽観ロック、rate limit、Problem Details を API の明示的な契約として扱う。

既存文書や実装からの移行量・手戻りは、方式選定の判断材料に含めない。方式そのものの適合性だけで比較する。

Decision:
クライアントとバックエンドの公開通信契約には、JSON REST API を採用する。アプリケーション固有 API の base path は `/api/v1` とし、OpenAPI を機械可読な契約として提供する。

- API の入力・出力は runtime schema を正本として定義し、境界で検証する。
- TypeScript 型と OpenAPI schema は runtime schema から導出し、同じ情報を手作業で重複定義しない。
- Web クライアントは OpenAPI または共通 contract から生成・構築した型付き client を使用し、素の `fetch` 呼び出しを画面ごとに散在させない。
- Route Handler は HTTP、認証情報、入力 DTO、Application DTO、HTTP response の変換だけを担当し、業務ロジックを持たない。
- Domain/Application 層は REST、OpenAPI、Next.js の型に依存しない。将来別の transport adapter を追加しても use case を再利用できる境界を維持する。
- HTTP method、status code、header、error code、認証・認可、idempotency、pagination、競合制御を endpoint ごとの契約として明示する。
- Auth.js など外部ライブラリが規定する標準 endpoint は、互換性のため `/api/v1` の例外にできる。例外は対象 Feature Spec に理由と契約境界を記録する。

Alternatives considered:

- tRPC: TypeScript の server/client 間でコード生成なしの end-to-end 型安全性と高い開発体験を得られる。ただし contract が TypeScript の router/procedure 型と tRPC client protocol に結合し、TypeScript 以外のクライアント、外部ツール、標準的な OpenAPI tooling からの利用に追加 adapter が必要になる。本システムでは transport 非依存の Application API と、HTTP 上で独立して検証可能な公開契約を優先するため採用しない。
- REST と tRPC の併用: Web 専用 BFF として tRPC を追加する案。Presentation adapter、validation、error mapping、認証・認可、observability、contract test が二系統になり、同じ use case の外部契約が分散するため採用しない。
- GraphQL: client が取得項目を柔軟に選択できるが、MVP の resource と use case は固定的であり、schema、resolver、認可、query complexity 制御を追加する利益が小さいため採用しない。

Consequences:

- TypeScript client の型安全性は tRPC の型推論ではなく、runtime schema、OpenAPI、型付き client により確保する。
- runtime schema、OpenAPI、実際の response の不一致を contract test と CI で検出する必要がある。
- API の versioning、status code、cache、header、idempotency、競合制御を標準 HTTP semantics で表現できる。
- TypeScript 以外の client や運用ツールも OpenAPI から統合できる。
- REST endpoint は Presentation adapter であり、Application use case と一対一である必要はない。画面都合を Domain/Application の公開契約へ漏らさない。

Security/operational impact:

- すべての公開 endpoint で runtime validation、認証・操作単位の認可、入力サイズ上限、rate limit の要否を定義する。
- エラーは Problem Details 形式を基礎とし、stack、SQL、provider response、機微情報を公開しない。
- OpenAPI から認証要件と主要な error response を追跡可能にするが、OpenAPI の記載だけを認可実装の代替にはしない。
- endpoint 単位で method、route template、status、latency、error code を計測できるようにする。email、自由記述、token 等を route parameter、metric label、log に含めない。

Review date: TypeScript 以外の主要クライアント追加時、API を外部公開する時点、または REST contract の保守コストが開発速度上の重大な制約になった時点で再評価する。
