# ADR-010: Web UI スタックと E2E 基盤

Status: accepted
Date: 2026-10-06

Context:
T-101〜T-204、T-401 までで API・Domain・Application が揃い、Phase 2.5(T-211〜T-217)で画面と Playwright E2E を実装する。画面ごとに方式がぶれないよう、スタイリング、コンポーネント方針、データ取得、route 保護、E2E とローカルのメール受信の方式を先に決める。制約は次のとおり。

- [ADR-009](ADR-009-api-style.md): Web は型付き client を使い、素の `fetch` を画面に散在させない。業務ロジックを Presentation に持たせない。
- [ADR-001](ADR-001-authentication.md): session は DB の Auth.js adapter table に永続化する(JWT-only ではない)。したがって session の有効性は DB でしか判定できない。
- [AGENTS.md](../../AGENTS.md): 第三者のデザイン・文言を複製しない。依存は最小限にし、アクセシビリティ(WCAG 2.2 AA 目標)を満たす。

Decision:

- **スタイリング**: CSS Modules と、`:root` に定義した design token(CSS 変数)を使う。Tailwind や UI kit(shadcn/ui、Radix 等)は導入しない。
- **コンポーネント**: `apps/web/src/components/` に自前の最小コンポーネント(Button、StateMessage、PageHeader、AppNav 等)を置く。コンポーネントは表示と操作だけを担当し、業務判断は API/Application に任せる。コンポーネントの追加は、2 画面以上で使われる、または a11y 上の共通化が必要な場合に限る。
- **データ取得**: 型付き API client(`apps/web/src/lib/api/client.ts`)に `fetch` を集約し、応答は `@habit-app/contracts` の runtime schema(zod)で検証する。サーバー状態のキャッシュと再取得は TanStack Query に任せる。画面から直接 `fetch` を呼ばない。Server Actions は使わない(公開契約を REST に一本化する ADR-009 と二系統になるため)。
- **route 保護**: 認証が必要な画面は route group `(app)` に置き、その layout(Server Component)が Auth.js の `auth()` で DB session を検証して、未認証なら `/login` へ redirect する。`middleware`/`proxy` では DB session を検証できない(Cookie の存在確認だけでは失効・改ざんを判別できない)ため使わない。画面の保護は UX のためであり、データの保護は常に API 側の認可が担う。client 側で API が `401` を返した場合は `/login` へ遷移する。
- **Error boundary**: `app/error.tsx`、`app/global-error.tsx`、`app/not-found.tsx` を共通方針とし、error の message/stack を画面に出さない(`digest` のみ)。
- **アクセシビリティ**: WCAG 2.2 AA を目標とする。skip link、landmark、見出し階層、visible な focus、色だけに依存しない状態表現、`prefers-reduced-motion` を共通基盤で保証する。
- **E2E**: Playwright(Chromium のみ)を `apps/web/e2e/` に置き、`pnpm test:e2e` で実行する。ビルド済みの `next start` に対して実行する。DB はローカルの Docker Compose の Postgres に E2E 専用 database を作って使い、開発用 database を汚さない。
- **ローカルのメール受信**: Docker Compose に Mailpit を追加する(SMTP `1025`、Web/API `8025`)。アプリの SMTP 設定(`SMTP_HOST`/`SMTP_PORT`)の送信先を Mailpit にし、E2E は Mailpit の HTTP API から確認メール・再設定メールの token を取得する。本番では使わない(`AUTH_EMAIL_SENDER=smtp` は本番で拒否される既存規則のまま)。
- **CI**: `pr-quality.yml` に E2E job を追加する。secret は使わず(`permissions: contents: read`、`pull_request` event のみ)、fork PR でも実行できる。

Alternatives considered:

- Tailwind CSS / shadcn/ui: 実装速度は速いが、依存・build 設定・コピーされたコンポーネントの保守が増え、MVP の画面数に対して過剰。独自の見た目を保ちやすく、第三者のデザインへの近似を避けやすい CSS Modules を優先する。
- Server Actions 中心: Next.js の標準機能でフォームは簡潔になるが、REST 契約(ADR-009)と並ぶ二系統の変更経路になり、冪等性・競合(409)・Problem Details を契約として一貫して扱いにくい。
- 素の `useEffect` + `fetch`: 依存は増えないが、キャッシュ、再取得、重複排除、楽観更新後の整合を画面ごとに再実装することになる。
- `middleware`/`proxy` による保護: 全 route を一括で守れるが、DB session を検証できない。Cookie の有無だけで通すと失効 session で保護画面が一瞬描画されうる。
- Playwright の Testcontainers 管理: ローカルは簡潔だが、`webServer` が `globalSetup` より先に起動するため、DB の接続先を事前に決められない。Compose の固定ポートを使い、E2E 専用 database を作る方式にした。

Consequences:

- 依存が増える: `@tanstack/react-query`(runtime)、`@playwright/test`(dev)。いずれも exact version で固定する。
- `(app)` layout のガードは、同一 layout 配下の client 遷移では再実行されない。session が途中で失効した場合の保護は、API の `401` → `/login` 遷移(client)と、API 側の認可が担う。
- コンポーネントを自前で持つため、a11y の確認(E2E の keyboard/focus 確認、`accessibility` skill による点検)をレビュー項目にする。
- E2E の実行には Docker(Postgres、Mailpit)が必要。

Security/operational impact:

- Cookie session は `HttpOnly`/`Secure`(本番)のまま。client は token を保存しない(localStorage/sessionStorage に認証情報を置かない)。
- API client は request/response body、メールアドレス、token をログへ出さない。TanStack Query の devtools は本番に含めない。
- 画面の error 表示にサーバー内部情報(stack、SQL、provider response)を出さない。
- Playwright の trace/screenshot/video は失敗時のみ保持し、fixture は架空データのみ。CI では artifact として外部へ送らない(追加する場合はレビュー対象)。
- Mailpit はローカル/CI 専用で、本番 infra(T-501 以降)には含めない。

Review date: T-217 完了時(Phase 2.5 完了時)、または UI の画面数・複雑さが自前コンポーネントの保守限界に達した時点で再評価する。
