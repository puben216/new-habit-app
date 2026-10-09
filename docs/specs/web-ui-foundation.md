# Web UI 基盤と E2E 基盤 Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-06
変更区分: Standard
ロードマップ項目: T-211

## 目的

Phase 2.5(T-212〜T-217)の各画面が共通の土台の上に作られるよう、UI 基盤(layout、ナビゲーション、認証ガード、読み込み/空/エラー状態、型付き API client)と、ブラウザで検証できる E2E 基盤(Playwright、Mailpit)を整える。画面ごとに方式がぶれることと、認証ガード・アクセシビリティ・エラー表示の取りこぼしを防ぐ。方式の決定は [ADR-010](../adr/ADR-010-web-ui-stack.md) に記録する。

## 成功指標

- 保護画面(`(app)` route group)は、未認証のアクセスでは画面内容を描画せず `/login` へ redirect する。有効な session では描画される(E2E smoke)。
- 画面から素の `fetch` を呼ばず、API 呼び出しは型付き client 1 箇所を通る。応答は runtime schema で検証され、不正な形は error として扱われる(Unit)。
- error boundary は、例外の message・stack を画面に出さない(Unit、E2E)。
- keyboard だけで skip link → ナビゲーション → 本文へ移動でき、focus が visible である(E2E)。
- `pnpm test:e2e` がローカルと CI で実行でき、Mailpit から確認メールの token を取得する helper が動作する(E2E)。
- fixture・trace・screenshot に実在の個人情報と Secret が含まれない。

## 範囲

- UI 基盤: root layout、design token(CSS 変数)、共通コンポーネント(Button、StateMessage、PageHeader、AppNav、SkipLink)、`(public)`/`(app)` route group、共通 error boundary(`error.tsx`、`global-error.tsx`、`not-found.tsx`)、loading 表示。
- 認証ガード: `(app)` layout の session 検証と未認証時の redirect。
- 型付き API client と TanStack Query の provider(`401` → `/login`、4xx は retry しない)。
- `apps/web` の server env 読み込みと validation(既存の `parseEnv` を共通の入口にする)。
- 暫定ページ: `/`(公開)、`/login`(公開。T-212 が置き換える暫定表示)、`/today`(保護。T-215 が置き換える空の保護画面)。
- Docker Compose への Mailpit 追加、`.env.example` の更新。
- Playwright 導入、`pnpm test:e2e`、E2E 用 database の準備、fixture(架空データのみ)、Mailpit helper、認証済み session を得る helper。
- CI(`pr-quality.yml`)への E2E job の追加(secret なし)。
- 文書: ADR-010、`AGENTS.md`(`pnpm test:e2e` の記述)、`docs/03`、`docs/06`、`docs/09`、`docs/10`。

## 対象外

- signup/login/logout/password reset/メール確認の画面と、`next` パラメータによる遷移元への復帰(T-212)。`/login` は暫定表示のみ。
- プロフィール、習慣、記録、ダッシュボード、通知設定の各画面(T-213〜T-217)。ナビゲーションには実装済みの route だけを載せる。
- 新規 API、DB の変更(Migration なし)、CSRF/Origin 検証の変更(T-212)、rate limit。
- 多言語化(日本語のみ)、dark mode、PWA、analytics。
- Playwright の Chromium 以外のブラウザ、visual regression、CI の artifact 保存。

## アクターと前提条件

| アクター      | 前提条件                                                                        |
| ------------- | ------------------------------------------------------------------------------- |
| Guest(未認証) | なし。`(public)` の画面だけ閲覧できる。`(app)` の画面は `/login` へ redirect    |
| Member        | email 確認済みで有効な session(T-101)を持つ。`(app)` の画面を閲覧できる         |
| 開発者/CI     | Docker(Postgres、Mailpit)が使える。E2E 専用 database と架空のユーザーのみを使う |

## 機能要件

### WUI-001 共通 layout とナビゲーション

- 全画面は `<html lang="ja">`、`header`/`nav`/`main` の landmark、画面ごとに 1 つの `h1` を持つ。
- 先頭に skip link(「本文へ移動」)があり、keyboard で最初に focus され、`main` へ移動できる。
- 保護画面の layout は `AppNav` を表示する。項目は設定配列 1 箇所で定義し、現在の画面に `aria-current="page"` を付ける。本タスクでは実装済みの `/today` だけを載せる。
- すべての操作可能要素は visible な focus 表示を持つ。`prefers-reduced-motion: reduce` で animation/transition を無効にする。

### WUI-002 認証ガード

- `(app)` layout は Auth.js の `auth()` で session を取得し、`actorUserIdFromSession` が `null` なら `/login` へ redirect する。未認証のとき子の内容を描画しない。
- `(public)` の画面は認証状態にかかわらず表示できる(認証済みユーザーの自動 redirect は T-212)。
- ガードの判定は DB session の有効性に基づく(失効・期限切れ・改ざんは未認証)。Cookie の存在だけで通さない。
- ガードは UX のためであり、データの保護は API の認可が担う。保護画面が呼ぶ API は常に actor ID を session から得る(既存仕様)。

### WUI-003 読み込み・空・エラー状態の共通方針

- `StateMessage` は `loading`/`empty`/`error` の 3 種で、見出しの階層を `headingLevel`(既定 `h2`、画面の主題として単独で表示する error/not-found は `h1`)で指定でき、色だけに依存せず見出しまたは文言とアイコン/ラベルで種類を示す。`loading` は `role="status"`、`error` は `role="alert"` を持つ。
- `error` は再試行操作(任意)を持てる。表示する文言は client が決めた固定の文言で、server の `message`/stack をそのまま出さない。
- `app/error.tsx`/`global-error.tsx` は固定文言と再試行ボタンを出し、`error.message`/`stack` を描画しない。`app/not-found.tsx` は固定文言とトップへの導線を出す。
- `(app)/loading.tsx` は `loading` 状態を表示する。

### WUI-004 型付き API client

- `apiRequest({ method, path, schema, body? })` は `/api/v1/*` への同一 origin の JSON request を送り、応答を渡された zod schema で検証して型付きの値を返す。
- `path` は `/api/v1/` で始まる相対パスだけを受け付ける(絶対 URL・`//`・`..` は拒否)。外部 origin へ request できない。
- 失敗は `ApiError`(`status`、`code`、`fieldErrors`、`requestId`)として投げる。`ApiError.message` は常に固定の文字列で、server の `message` は保持しない(WUI-INV-003)。Problem Details(`{code, message, fieldErrors?, requestId}`)として解釈できない応答は、`code: "unexpected_response"` の `ApiError` にする。応答が schema に合わない場合は `code: "invalid_response"`、network 失敗・timeout は `code: "network_error"`、許可されない path は `code: "invalid_request_path"`(request を送らない)とする。呼び出し側が `signal` で取り消した場合は `ApiError` にせず元の abort をそのまま伝える。
- request は timeout(既定 10 秒)と abort に対応する。`401` の場合は `ApiError.status === 401` を返し、遷移の判断は query client の共通処理が行う。
- body、email、token、自由記述をログへ出さない(client は `console` へ記録しない)。
- 変更系 request(`POST`/`PUT`/`PATCH`/`DELETE`)は `Content-Type: application/json` を付ける。冪等性 key や `If-Match` の付与は各画面(T-214/T-215)が引数で指定できる(`headers`)。

### WUI-005 Query client と provider

- root に `QueryClientProvider` を置く。query は network 失敗(`network_error`)と `5xx` だけを最大 2 回まで retry し、`4xx`・契約不一致(`invalid_response`/`unexpected_response`)・想定外の例外は retry しない。mutation は retry しない。
- `ApiError.status === 401` の query/mutation 失敗は、`/login` へ遷移し、キャッシュ(`queryClient.clear()`)を破棄する。
- 認証情報や個人データを `localStorage`/`sessionStorage` に保存しない。

### WUI-006 server env の読み込みと validation

- `apps/web` の server 側は `getServerEnv()` を唯一の入口とし、`parseEnv(process.env)` の結果を遅延かつ memoize して返す(`next build` の import 時に検証しない。既存方針)。不正な env は起動時でなく初回利用時に、変数名のみで Secret の値を含まない error になる。
- client(browser)へ渡す env はない。`NEXT_PUBLIC_*` を使わない。

### WUI-007 ローカルのメール受信(Mailpit)

- Docker Compose に `mailpit` を追加する(SMTP `1025`、Web/API `8025`、データは永続化しない)。既定の `SMTP_HOST=localhost`/`SMTP_PORT=1025` のままローカルのアプリのメールが Mailpit に届く。
- `pnpm mail:up`/`pnpm mail:down` で起動・停止する。Mailpit はアプリの DB と独立している。

### WUI-008 Playwright E2E 基盤

- `pnpm test:e2e` は、E2E 専用 database(`habit_app_e2e`)を作り直して Migration を適用し、ビルド済みアプリを起動して Chromium のテストを実行する。開発用 database(`habit_app_dev`)に触れない。
- テストは email が一意な架空ユーザーだけを使い、テスト間で状態を共有しない。
- 認証済み session を得る helper(`signUpAndSignIn`)は、API で signup → Mailpit から確認 token を取得 → `verify-email` → Auth.js の credentials callback で session cookie を取得する。helper は本物の認証フロー(T-101)を使い、DB への直接 insert や認証の迂回をしない。
- `trace`/`screenshot`/`video` は失敗時のみ保持する。fixture と assertion に Secret を含めない。
- Mailpit helper(`waitForEmail`、`extractTokenFromEmail`)は、宛先で絞り込み、timeout 付きで待機し、見つからなければ原因が分かる error を投げる(宛先以外の本文は error に含めない)。

### WUI-009 CI での E2E

- `pr-quality.yml` に E2E job を追加する。`pull_request`(main 向け)で実行し、`permissions: contents: read`、secret を参照しない。`AUTH_SECRET` 等は E2E 専用の公開してよいダミー値(ファイルに明記)を使う。
- job は Docker Compose で Postgres と Mailpit を起動し、Chromium をインストールして `pnpm test:e2e` を実行する。

## 業務ルールと不変条件

- WUI-INV-001(業務ロジックを持たない): Presentation は表示と操作だけを担い、業務ルールの判定を再実装しない。API の判断(`422` 等)を表示するだけである。
- WUI-INV-002(保護画面の非描画): 未認証のとき `(app)` 配下の子要素は描画されない(redirect が先に起きる)。
- WUI-INV-003(固定の error 文言): 画面に表示する error 文言は client が持つ固定の文言である。server の `message` は fieldErrors の表示(T-212 以降)を除き、そのまま描画しない。
- WUI-INV-004(client に認証情報を保持しない): token、パスワード、session を JS から読み書きしない(Cookie は `HttpOnly` のまま)。
- WUI-INV-005(外部 origin への request 禁止): API client は同一 origin の `/api/v1/` 以外へ request しない。
- WUI-INV-006(a11y の下限): すべての画面は landmark、`h1`、skip link、visible focus、色以外の状態表現を満たす。
- WUI-INV-007(E2E の隔離): E2E は専用 database と一意な架空ユーザーだけを使い、開発用データと本番相当のデータに触れない。

## 状態遷移

| 現在の状態 | 操作                        | 次の状態              | 拒否される条件                 |
| ---------- | --------------------------- | --------------------- | ------------------------------ |
| 未認証     | `(app)` の画面を開く        | `/login` へ redirect  | なし(常に redirect)            |
| 認証済み   | `(app)` の画面を開く        | 画面を描画            | なし                           |
| 認証済み   | session 失効後に API を呼ぶ | `/login` へ遷移       | なし(`401` を受けた時点で遷移) |
| 任意       | 描画中に未処理の例外        | error boundary の表示 | なし(再試行で再描画を試みる)   |
| 任意       | 存在しない path を開く      | not-found の表示      | なし                           |

## 受け入れ基準

```gherkin
Scenario: 未認証で保護画面を開くと /login へ移る
  Given 未認証のブラウザ
  When /today を開く
  Then /login へ redirect される
  And 保護画面の見出しは描画されない

Scenario: 認証済みで空の保護画面を開く
  Given signup・メール確認・login 済みのユーザー
  When /today を開く
  Then 見出し「今日」と空状態の表示が出る
  And ナビゲーションの「今日」に aria-current="page" が付く

Scenario: keyboard だけで本文へ移動できる
  Given 認証済みで /today を開いた
  When Tab を 1 回押す
  Then skip link に focus が当たり、Enter で main に focus が移る
  And Tab で進めたとき focus は常に visible である

Scenario: 存在しない path
  When /no-such-page を開く
  Then 固定文言の not-found が表示され、404 status である

Scenario: API の error を画面に漏らさない
  Given API が Problem Details(code と message)を返す
  When client が ApiError を受けて error 状態を表示する
  Then 画面には固定文言だけが出て、server の message と stack は出ない

Scenario: Mailpit からの token 取得
  Given signup したユーザーの確認メールが Mailpit に届く
  When helper が宛先で絞り込んで待機する
  Then 確認 token が取得でき、verify-email に成功する
  And 宛先のメールが届かないときは timeout で原因が分かる error になる

Scenario: 不正な path への API request を拒否する
  When client が "https://evil.example/x"、"//evil.example"、"/api/v1/../auth" を渡される
  Then request は送られず error になる
```

## 認可マトリクス

| 操作                         | Guest | Member | Admin | 所有権ルール                                  |
| ---------------------------- | ----: | -----: | ----: | --------------------------------------------- |
| `(public)` 画面の閲覧        |   Yes |    Yes |   Yes | なし                                          |
| `(app)` 画面の閲覧           |    No |    Yes |   N/A | session の user のみ。admin 画面は T-403 以降 |
| `/api/v1/*`(既存 API の認可) |  既存 |   既存 |   N/A | 既存の仕様のまま(本タスクは変更しない)        |

## APIとイベント

N/A。新規・変更する API とイベントはない。client は既存の `/api/v1/*` と Auth.js の `/api/auth/*` の消費側である。

## データとMigration

N/A。DB の変更はない(Migration なし)。E2E 専用 database(`habit_app_e2e`)はローカル/CI の Compose の Postgres 上に作る使い捨てで、実行のたびに作り直す。

## 失敗・境界ケース

- session が途中で失効: `(app)` の layout は同一 layout 内の client 遷移では再実行されないため、次の API 呼び出しの `401` で `/login` へ遷移する(WUI-005)。画面内に失効後のデータが残る期間は、次の API 呼び出しまでの間に限られる。
- 応答の形が契約と異なる(部分的な障害、プロキシの HTML エラー): `invalid_response`/`unexpected_response` として error 状態を表示する。
- network 失敗・timeout: `network_error` として再試行できる error 状態を表示する。
- Mailpit が起動していない/メールが届かない: helper が timeout し、宛先(マスクしない架空アドレス)と待機時間を error に含める。
- E2E の並列実行: ユーザーの email を一意にし、テスト間の共有状態を持たない。
- `NODE_ENV`: `next start` は既定で `production` となり `AUTH_EMAIL_SENDER=smtp` が拒否されるため、E2E は `NODE_ENV=test` を指定して起動する(本番相当の挙動は変えない。既存の `parseEnv` の規則は変更しない)。

## セキュリティとプライバシー

- 収集データ: なし(新しい収集はない)。
- 外部送信データ: なし。ローカルの Mailpit(localhost)以外へ送信しない。E2E の SMTP 送信先は localhost のみ。
- ログ禁止データ: メールアドレス、token、パスワード、自由記述、request/response body、cookie。
- 脅威と対策:
  - IDOR/BOLA: 本タスクは新規 resource を持たない。画面の保護は UX であり、API の認可(session の actor ID)が正本。
  - XSS: React の既定のエスケープを使い、`dangerouslySetInnerHTML` を使わない(ESLint で検出)。server 文言を HTML として描画しない。
  - CSRF: 本タスクは変更系 API を呼ぶ画面を持たない。API client は同一 origin のみに request する。Origin 検証の強化は T-212。
  - Open redirect: redirect 先は固定の `/login` のみ。`next` は T-212 で同一 origin の相対 path のみ許可するよう設計する。
  - 情報露出: error boundary は message/stack を出さない。`digest` は画面に表示せず、サーバー側のログと突き合わせる用途に限る。
  - fork PR: E2E job は `pull_request` event で secret を参照せず、書き込み権限を持たない。`pull_request_target` を使わない。
  - fixture/trace: 架空データのみ。失敗時のみ trace を保持し、CI の外部 artifact には出さない。
  - 依存: 追加する依存は `@tanstack/react-query`(runtime)、`@playwright/test`、`fast-check`(dev)。exact version で固定し、`pnpm audit` と Secret scan の対象とする。

## AI要件

N/A。AI を利用しない。

## 可観測性と運用

- ログ: 本タスクで新しいログは追加しない。error boundary は `digest` のみをサーバー側ログと突き合わせる(フレームワーク標準)。
- メトリクス/アラート: N/A(インフラ未着手。T-501 以降)。
- Runbook: ローカル開発の手順(`pnpm db:up`、`pnpm mail:up`、`pnpm test:e2e`)を `README.md` に追記する。E2E の失敗調査は Playwright の trace(ローカル)を使う。
- 展開/ロールバック: Feature Flag は不要(既存 API に影響しない UI の追加)。問題があれば revert する。CI の E2E job が不安定な場合は job 単位で無効化できる(required check にする判断は T-212 以降の安定後)。

## テスト対応表

| 要件    | Unit                                                                                            | Integration | E2E                                                       |
| ------- | ----------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| WUI-001 | nav 設定の整合(`aria-current`、重複なし)                                                        | N/A         | skip link と focus、landmark、`h1`                        |
| WUI-002 | `requireSession` の分岐(null/空文字/有効)、`actorUserIdFromSession`(既存)                       | N/A         | 未認証 redirect、認証済みで描画                           |
| WUI-003 | `StateMessage` の role と文言、error boundary が message/stack を描画しない                     | N/A         | not-found の表示と 404 status                             |
| WUI-004 | path 検証(性質テスト)、schema 検証、Problem Details の解釈、network/timeout、`invalid_response` | N/A         | N/A(smoke では API client を直接使う画面なし。T-212 以降) |
| WUI-005 | retry 判定(性質テスト)、401 の処理                                                              | N/A         | N/A(同上)                                                 |
| WUI-006 | `getServerEnv` の memoize と不正 env の error(値を含まない)                                     | N/A         | N/A                                                       |
| WUI-007 | N/A                                                                                             | N/A         | Mailpit 経由のメール取得(WUI-008 と共通)                  |
| WUI-008 | Mailpit helper の token 抽出(性質テスト)、待機の timeout                                        | N/A         | `signUpAndSignIn` による認証済み session の取得           |
| WUI-009 | N/A                                                                                             | N/A         | CI 上での実行(PR の check で確認)                         |

## 未決事項

なし。次は実装中に確認する項目であり、実装を左右しない。

- 認証済みユーザーが `/login` を開いたときの自動 redirect は T-212 で決める。
- CI の E2E job を required check にする時期は、安定性を確認した後(T-212 以降)に決める。
- ナビゲーションの項目(習慣、ダッシュボード、通知、プロフィール)は各画面のタスクで追加する。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-06
Reviewed by: —

| Gate                 | Result | Evidence                                                                          |
| -------------------- | ------ | --------------------------------------------------------------------------------- |
| Product              | Pass   | 目的、成功指標、範囲/対象外。ロードマップ T-211(Phase 2.5)に含まれる              |
| Specification        | Pass   | WUI-001〜WUI-009、WUI-INV-001〜007、受け入れ基準、失敗・境界ケース                |
| Domain and Time      | N/A    | 業務ルール・日付・時刻を扱わない(Presentation のみ)。冪等性が必要な操作もない     |
| API and Data         | N/A    | 新規 API・DB 変更なし(Migration なし)。既存 API の消費側であることを確認済み      |
| Security and Privacy | Pass   | セキュリティとプライバシー節(脅威、ログ禁止、fork PR)、ADR-010 の Security impact |
| AI                   | N/A    | AI を利用しないため                                                               |
| Testing              | Pass   | テスト対応表、Mailpit は実物の SMTP/HTTP で検証、fixture は架空データのみ         |
| Operations           | Pass   | 可観測性と運用節(ロールバックは revert、CI job の無効化)                          |
| Planning             | Pass   | [../plans/web-ui-foundation.md](../plans/web-ui-foundation.md)                    |

### 受容リスク

- `(app)` layout のガードは同一 layout 内の client 遷移で再実行されない。API の `401` と API 側の認可で補う(ADR-010 に記録)。
- E2E に Docker(Postgres、Mailpit)が必要で、CI の実行時間が増える。

### 未決事項

なし
