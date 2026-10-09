# Web UI 基盤と E2E 基盤 Implementation Plan

Status: Ready
責任者: TBD
最終更新: 2026-10-06
Spec: [../specs/web-ui-foundation.md](../specs/web-ui-foundation.md)
変更区分: Standard

## 方針

既存の API・Application には触れず、`apps/web` の Presentation と開発基盤だけを追加する。判断は [ADR-010](../adr/ADR-010-web-ui-stack.md) に従う。

1. **env**: `apps/web/src/server/env.ts` に `getServerEnv()`(memoize した `parseEnv`)を置き、`auth-container.ts` の直接の `parseEnv` 呼び出しを置き換える。他の container は env を直接読んでいないことを確認する。
2. **UI 基盤**: `apps/web/src/app/globals.css`(design token、reset、focus、reduced-motion)、`components/`(Button、StateMessage、PageHeader、AppNav、SkipLink、各 `*.module.css`)。AppNav の項目は `components/nav-items.ts` の配列 1 箇所で定義する。
3. **route 構成**: `app/(public)/page.tsx`・`app/(public)/login/page.tsx`(暫定)、`app/(app)/layout.tsx`(ガード+AppNav)・`app/(app)/today/page.tsx`(空状態)・`app/(app)/loading.tsx`、`app/error.tsx`・`app/global-error.tsx`・`app/not-found.tsx`。既存の `app/page.tsx` は `(public)` へ移す。ガードの分岐は `server/session-guard.ts`(依存を注入できる関数)に切り出して Unit で検証し、`server/require-session.ts` が Auth.js と `redirect` を渡す。`(app)/layout.tsx` は session に依存するため `dynamic = "force-dynamic"` とし、build 時に prerender しない。
4. **API client**: `lib/api/client.ts`(`apiRequest`、`ApiError`、path 検証、timeout/abort、Problem Details 解釈)、`lib/api/query-client.tsx`(`QueryClientProvider`、retry 判定、401 処理)。client のコードは `fetch` と `window.location` を引数で注入できる形にして Unit で検証する。
5. **Mailpit/env**: `docker-compose.yml` に `mailpit` を追加、`package.json` に `mail:up`/`mail:down`、`.env.example` に Mailpit の注記を追加、`README.md` の開発手順を更新する。
6. **E2E 基盤**: `apps/web/playwright.config.ts`、`apps/web/e2e/`(`support/mailpit.ts`、`support/auth.ts`、`support/e2e-env.ts`、`scripts/prepare-database.ts`、`smoke.spec.ts`)。webServer は `prepare-database` → `next build` → `next start`(`NODE_ENV=test`、`AUTH_TRUST_HOST=true`)。root の `test:e2e` は `pnpm --filter web run test:e2e` に委譲する。
7. **CI**: `pr-quality.yml` に `e2e` job を追加する(`quality` job とは独立、secret なし)。
8. **文書**: `AGENTS.md` の `pnpm test:e2e` の記述、`docs/03`(Presentation 構成)、`docs/06`(E2E の方針)、`docs/09`(T-211 の完了記録)、`docs/10`(D-14: UI スタック)。

## 影響分析

| 領域           | 変更                                                              | リスク                                                                               |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Domain         | なし                                                              | なし                                                                                 |
| Application    | なし                                                              | なし                                                                                 |
| Infrastructure | なし(Mailpit は Compose のみ)                                     | 低                                                                                   |
| Presentation   | `apps/web` に UI 基盤、client、route group、error boundary を追加 | 中(既存 `app/page.tsx` の移動、dependency-cruiser/ESLint の境界の再確認)             |
| Database       | なし(E2E 専用 database は使い捨て)                                | 低                                                                                   |
| API/Event      | なし                                                              | なし                                                                                 |
| AWS/Terraform  | なし                                                              | なし                                                                                 |
| Observability  | 変更なし                                                          | なし                                                                                 |
| CI             | `e2e` job を追加                                                  | 中(実行時間、Docker/Chromium の取得失敗。job 単位で独立させ、`quality` に影響しない) |

## インターフェースと契約

- `apiRequest<T>(options)`: `{ method, path, schema, body?, headers?, signal?, timeoutMs?, fetchImpl? }` → `Promise<T>`。`ApiError { status, code, message, fieldErrors?, requestId? }`。
- `isRetryableError(failureCount, error)`: query の retry 判定(純粋関数)。
- `guardSession({ getActorUserId, redirectToLogin })`(`server/session-guard.ts`。`redirectToLogin` は `never` を返し、未認証なら子の描画へ進ませない。`requireSession` が Auth.js と `redirect` を渡して使う)。
- `getServerEnv(): Env`(memoize)。テスト用に `resetServerEnvForTest()` は公開しない(`parseEnv` を引数で注入できる `createServerEnvGetter(parse)` を内部で使う)。
- E2E helper: `waitForEmail({ to, timeoutMs })`、`extractTokenFromEmail(body)`、`signUpAndSignIn(context, options?)`。

## データMigration

N/A。DB の変更がないため Expand/Backfill/Switch/Contract は不要。ロールバックは PR の revert のみ。

## セキュリティレビュー

- 認証/認可: ガードは UX。API の認可を変更しない。`(app)` の layout は `auth()`(DB session)で判定する。
- 個人情報/Secret/ログ: client は `console` へ記録しない。E2E の `AUTH_SECRET` は公開してよい E2E 専用のダミー値で、`e2e-env.ts` に明記する(gitleaks の誤検知は E2E 専用の固定値であることをコメントで説明)。fixture は架空データのみ。
- 悪用対策: 外部 origin への request 禁止(path 検証)、`dangerouslySetInnerHTML` 不使用、fork PR に secret を渡さない(`pull_request`、`permissions: contents: read`)。

## テスト計画

| 要件            | テスト種別        | 予定テスト                                                                                                                                                                                   |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WUI-004/005     | Unit(+性質テスト) | path 検証(`/api/v1/` 配下の任意の安全な path は許可、スキーム/`//`/`..`/改行付きは拒否する性質)、Problem Details/schema/network/timeout の分類、retry 判定(4xx は常に false、失敗回数の上限) |
| WUI-002         | Unit              | `guardSession`(未認証で redirect、有効なら user ID、session 取得失敗は redirect せず伝播)                                                                                                    |
| WUI-003         | Unit              | `StateMessage` を `renderToStaticMarkup` で検証(role、文言、種類ごとのラベル)、error boundary が `error.message` を描画しない                                                                |
| WUI-001         | Unit              | nav 設定の整合(href の重複なし、`/` 始まり、現在位置の判定)                                                                                                                                  |
| WUI-006         | Unit              | `getServerEnv` の memoize、不正 env の error に値が含まれない                                                                                                                                |
| WUI-007/008     | Unit(+性質テスト) | Mailpit helper: token 抽出(URL エンコードされた任意の token を往復できる性質)、宛先絞り込み、timeout の error 内容                                                                           |
| WUI-001/002/003 | E2E               | 未認証で `/today` → `/login`、認証済みで `/today` が描画、skip link と focus、not-found(404)                                                                                                 |
| WUI-008/009     | E2E               | `signUpAndSignIn`(Mailpit から token 取得)、CI での実行                                                                                                                                      |

テスト品質の 3 観点: 性質テストは fast-check(新規 dev 依存)、変異テストは Stryker 未導入のため、主要な判定(path 検証、retry 判定、ガード分岐、token 抽出)を手動で壊して Unit が失敗することを確認する。敵対的審査として、実装後に別の観点(攻撃者視点・a11y)で差分を読み、結果を完了報告に記載する。

## 展開と運用

- Feature Flag: 不要(既存 API に影響しない UI 追加)。
- デプロイ順序: 通常のマージのみ。インフラ変更なし。
- メトリクス/アラーム: N/A(インフラ未着手)。
- ロールバック条件と手順: build/E2E が壊れる、または既存 route に影響が出た場合に PR を revert する。CI の `e2e` job が不安定なときは job を一時的に無効化する(`quality` は独立)。

## タスク分解

1. env(`getServerEnv`)と、その Unit。
2. UI 基盤(token、共通コンポーネント、route group、error boundary、ガード)と Unit。
3. 型付き API client と Query provider、Unit(性質テスト含む)。
4. Mailpit(Compose、scripts、`.env.example`、README)。
5. Playwright 基盤(config、database 準備、helper、smoke)と Mailpit helper の Unit。
6. CI の `e2e` job。
7. 文書(`AGENTS.md`、`docs/03`/`06`/`09`/`10`)とセルフレビュー、全品質コマンドの実行。

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行: T-101(auth)、T-102(session actor)。いずれも完了済み。
- 外部: Docker(Postgres、Mailpit)、Chromium(`playwright install`)。
- ADR-010 が Accepted。

## リスク

| リスク                                                            | 対策                                                                             | 責任者 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| `NODE_ENV=test` での `next start` が想定どおり動かない            | 早期に smoke で確認。動かない場合は E2E 専用の起動方法を再設計し Spec を更新する | TBD    |
| Auth.js の host 検証(`AUTH_TRUST_HOST`)で E2E の login が失敗する | `AUTH_TRUST_HOST=true` を E2E のみに設定する                                     | TBD    |
| CI の Chromium/Docker 取得の不安定さ                              | `e2e` job を独立させる。required check 化は安定後                                | TBD    |
| 自前コンポーネントの a11y の漏れ                                  | E2E の keyboard 確認、`accessibility` の観点でのセルフレビュー                   | TBD    |

## 着手条件

- [x] Spec Status が Ready
- [x] 必須 ADR(ADR-010)が Accepted
- [x] API/event 契約がレビュー済み、または N/A(N/A)
- [x] Migration 方針がレビュー済み、または N/A(N/A)
- [x] 認可・データ保護方針がレビュー済み
- [x] テスト環境と Fake/Stub を準備できる(Docker 稼働を確認済み)
- [x] 依存 task が完了している
- [x] rollout/rollback 方針が決定している
- [x] 実装前ゲートの全必須項目が Pass または根拠付き N/A
