# 9. 開発ロードマップと MVP タスク分割

## 共通 Definition of Done

詳細な完了条件は [`docs/governance/definition-of-done.md`](governance/definition-of-done.md)、実装開始条件は [`docs/governance/implementation-readiness-gate.md`](governance/implementation-readiness-gate.md) を正本とする。

各タスクは必ず次の順で行う。

1. 設計: 要件・受け入れ基準・影響範囲・脅威・migration/API 契約を確認
2. 実装: 最小差分、依存方向、型付き境界、必要な telemetry を実装
3. テスト: 新規 Unit/Integration/E2E を追加し、lint/typecheck/test/build を成功させる
4. セルフレビュー: diff、認可、エラー、ログ、後方互換、運用手順を確認

タスクは原則 0.5〜2 日、独立してレビュー可能なサイズにする。

Standard 変更として着手する各タスクは、実装前に [`feature-spec.template.md`](templates/feature-spec.template.md) から Feature Spec を作成し、その `Roadmap Task` 欄に対応する T-ID（本ページの見出し番号）を記載する。1 つの T-ID に複数 Spec が対応する場合、または 1 つの Spec が複数 T-ID にまたがる場合はその旨を明記する。

## Phase 0: 意思決定と基盤

### T-001 設計承認と ADR

- 設計: `docs/10-decisions-and-open-questions.md` の P0 を決定
- 成果: Auth、ORM、hosting、メール、法務の ADR は accepted 済み（[ADR-001](../docs/adr/ADR-001-authentication.md)〜[ADR-002](../docs/adr/ADR-002-orm.md)、[ADR-004](../docs/adr/ADR-004-hosting.md)〜[ADR-006](../docs/adr/ADR-006-legal-baseline.md)）。AI provider は pilot 期間中（[ADR-003](../docs/adr/ADR-003-ai-provider.md)、T-305 完了時〜T-505 開始前に確定）
- テスト: 文書リンク/markdown lint
- レビュー: MVP 外機能が混入していないか

### T-002 Monorepo scaffold

- 設計: package boundary、scripts、Node/pnpm version
- 実装: workspace、strict tsconfig、ESLint/Prettier、import boundary
- テスト: lint/typecheck/build の空実行
- レビュー: `any` と循環依存を CI で防止できるか

### T-003 ローカル開発基盤

- 設計: env schema、Postgres 起動、secret 管理
- 実装: Docker Compose/Testcontainers、typed config、example env
- テスト: missing/invalid env、DB health
- レビュー: secret や個人データが fixture にないか

### T-004 DB baseline/migration

- 設計: ERD、index、delete、role
- 実装: Prisma（[ADR-002](adr/ADR-002-orm.md)）で `04-database-design.md` の 13 テーブルを 1 つの初期 migration として実装。schema/migration は `packages/infrastructure/database/`。差分・追加決定は[04-database-design.mdの「実装時の補足」](04-database-design.md#実装時の補足t-004)を参照
- テスト: Testcontainers で起動した実 PostgreSQL に対し fresh migration 適用、CHECK/exclusion constraint 違反、正常系 CRUD を Integration Test で検証（`pnpm test:integration`）。upgrade は後続 migration 追加時に対象
- レビュー: FK index、lock、rollback/forward fix

### T-005 CI baseline

- 設計: `main` 向け PR (`pull_request`) を対象に、`.github/workflows/pr-quality.yml`（品質ゲート）と`.github/workflows/security-scan.yml`（secret scan/依存脆弱性）に分離。GitHub-hosted ubuntu runner は Docker を標準搭載するため Testcontainers 経由の`test:integration`に追加の`services:` Postgres は不要（実測で確認）。artifact upload は未導入（現状ログのみで十分と判断、必要になれば追加）。OIDC/AWS role 引き受けは infra 未着手のため対象外（T-503 で追加）。`06-quality-and-operations.md`が挙げる SAST は、現時点では Auth/API（T-101〜）が未実装でアプリケーションコードの攻撃面がほぼ無く検出価値が薄いため今回は対象外とし、T-101 Auth adapter 着手時に導入を再検討する。依存方向チェック（`pnpm lint:boundaries`、dependency-cruiser）は T-002/T-003 で既に導入済みのため本タスクでの追加対応は無し
- 実装:
  - `pr-quality.yml`: `format:check`/`lint`/`lint:boundaries`/`typecheck`/`build`/`test:unit`/`test:integration`を単一 job で順に実行。`actions/checkout`/`pnpm/action-setup`/`actions/setup-node`は commit SHA pin。pnpm version は`package.json`の`packageManager`から自動検出。`actions/setup-node`の`cache: pnpm`で pnpm store をキャッシュ
  - `security-scan.yml`: `gitleaks/gitleaks-action`（secret scan、PR コメント機能は無効化し write 権限を要求しない）と`pnpm audit --audit-level=moderate`（依存脆弱性、moderate 以上を必須ゲート）の 2 job。Prisma CLI 自身が同梱する開発時専用依存（`prisma>mysql2`, `prisma>@prisma/config>deepmerge-ts`）由来の既知 3 件（GHSA-ggr8-5vv4-36mx、GHSA-3f6p-5ww8-9rcr、GHSA-rgwj-5xj2-c3m3）は`pnpm-workspace.yaml`の`auditConfig.ignoreGhsas`にレビュー済みとして記録し ignore。Terraform/IaC scan、SBOM 生成、staging deploy は未実装（T-501 以降で追加）
  - 両 workflow とも`permissions: contents: read`を既定にし、fork PR を含め書き込み権限を渡さない
- テスト: ローカルで`format:check`/`lint`/`lint:boundaries`/`typecheck`/`build`/`test:unit`/`test:integration`を全て成功させたうえで、`env.test.ts`のアサーションを意図的に不一致にして`test:unit`が失敗すること、`env.ts`に未使用変数を仕込んで`lint`が失敗することをそれぞれ確認してから revert（詳細は本タスクの PR 説明を参照）
- レビュー: fork PR に渡す secret は無し。`gitleaks-action`が使う`GITHUB_TOKEN`は実行ごとの短命 token であり長期 secret ではない。両 workflow とも`permissions: contents: read`で write 権限を要求しないため fork PR でも安全

## Phase 1: Identity と習慣 CRUD

### T-101 Auth adapter と session

- Auth.js（NextAuth）integration、Credentials（email+password）、callback/session/logout（Google/GitHub OAuth は MVP スコープ外、admin TOTP 2FA は T-403。[ADR-001](adr/ADR-001-authentication.md) 2026-09-16 改訂）
- Unit: session mapping。Integration: unauthorized/expired/rotation
- E2E: signup/login/logout/password reset

### T-102 User/Profile

- Domain/Application、`GET/PATCH /me`、timezone validation
- 設計: Feature Spec([user-profile.md](specs/user-profile.md))と Implementation Plan([user-profile.md](plans/user-profile.md))を作成
- Unit: policy/value object。Integration: persistence/ownership
- E2E: onboarding profile。Playwright 未導入のため本タスクでは対象外とし、Route Handler 単体テストと Repository Integration Test で代替する。Playwright 導入後に追加する

### T-103 Habit Domain

- 設計: Feature Spec([habit-domain.md](specs/habit-domain.md))と Implementation Plan([habit-domain.md](plans/habit-domain.md))を作成
- 実装: `packages/domain/src/habits/`に`HabitKind`、`ScheduleVersion`(値オブジェクト)、`Habit`(集約エンティティ)を、DB/HTTP/frameworkに一切依存しない純粋なTypeScriptとして実装。kindの作成後不変、reduceのtargetCount=1固定、daysOfWeekの値域(0〜6)・非空・重複禁止、ScheduleVersion有効期間の重複禁止(DBのexclusion constraintと同趣旨をDomainで先に検知)、スケジュール編集時に既存版のeffectiveFromを保持したまま新版を追加する`changeSchedule`を実装。repository/use case/永続化はT-104のスコープとして含めていない
- テスト: `pnpm test:unit`でUnit Testを追加(build/reduceの成功判定`isTargetMet`、kind不変性、ScheduleVersionのバリデーション、有効期間重複の拒否/受理、スケジュール編集時の有効開始日保持を含む56件、5ファイル)
- レビュー: `pnpm format:check`/`lint`/`lint:boundaries`/`typecheck`/`build`/`test:unit`をすべて実行し成功を確認。reduceのquantity意味論等はSpecのOpen Questionとして明記し、T-104着手前に確認する

### T-104 Habit repository/use cases/API

- 設計: Feature Spec([habit-api.md](specs/habit-api.md))と Implementation Plan([habit-api.md](plans/habit-api.md))を作成し、Implementation Readiness Gate を通過
- 実装: T-103 の Domain を再利用し、`HabitRepositoryPort`/use case 5 本(Application)、`PrismaHabitRepository`(Infrastructure、条件付き UPDATE による楽観ロック、`(created_at, id)` keyset の cursor pagination)、`/api/v1/habits` 5 endpoint(Presentation、session の actor、Origin 検証、Problem Details)を実装。Domain には DB 行の復元用 `reconstituteHabit` のみ追加。Migration なし
- テスト: Unit(Domain/Application/Contracts/HTTP handler)と、実 PostgreSQL の Integration(constraint、IDOR、並行更新の 409、pagination)を追加
- 未実装(Spec の 対象外/受容リスク): `Idempotency-Key`、rate limit、`localTime`、構造化ログ、OpenAPI 生成。文字数上限は P2 未決のため暫定値
- E2E: Playwright 未導入のため、導入後に build/reduce CRUD を追加

## Phase 2: Tracking と可視化

### T-201 Schedule calculation

- タイムゾーン/DST 対応の予定機会生成
- Unit/property test: 境界日、非予定日、version 切替
- 設計: Feature Spec([schedule-calculation.md](specs/schedule-calculation.md))と Implementation Plan([schedule-calculation.md](plans/schedule-calculation.md))を作成
- 実装: `packages/domain/src/habits/`に`localDateAt`(IANA timezone のローカル暦日、DST は壁時計 0 時境界)、`dayOfWeekOf`/`addCalendarDays`(UTC 暦演算)、`resolveScheduleForDate`/`scheduledOccurrenceOn`/`generateOccurrences`(版切替対応、範囲上限 366 日)、`weekStartOf`を純粋関数として追加。`findScheduleVersionForDate`は`resolveScheduleForDate`へ委譲(有効期間が重複する版は例外)。`quantity`は扱わないため reduce の意味論は T-202 着手前に確認する
- テスト: `pnpm test:unit`(DST 春/秋、日付変更線、うるう日、版切替日、上限、シード固定の性質テストを含む)、`format:check`/`lint`/`lint:boundaries`/`typecheck`/`build`を実行し成功を確認。DB/API 変更がないため`test:integration`は対象外

### T-202 Habit entry

- today query、entry upsert、idempotency
- Integration: duplicate、concurrency、ownership
- E2E: 成功/未実施/skip/訂正
- 設計: Feature Spec([habit-entry.md](specs/habit-entry.md))と Implementation Plan([habit-entry.md](plans/habit-entry.md))を作成。reduce は`quantity`を持たず`status`のみ、対象日は今日から過去 7 日、予定のない日は 422 と決定(D-12)
- 実装: Domain `resolveHabitEntry`(build の`success`は`quantity >= targetCount`、`missed`は途中経過、`skipped`/reduce は`quantity`なし)、Application `getTodayScheduleUseCase`/`upsertHabitEntryUseCase`(「今日」は`localDateAt(now, profile.timezone)`)、Infrastructure `PrismaHabitEntryRepository`(`INSERT ... ON CONFLICT`の単一文で冪等 upsert、`public_id`+`user_id`で習慣を解決)、Migration(`quantity`の CHECK)、`GET /api/v1/schedule/today`、`PUT /api/v1/habits/{habitId}/entries/{date}`
- テスト: Unit(Domain/Application/契約/handler)と Integration(実 PostgreSQL: upsert 往復、再送、並行 6 件で 1 レコード、IDOR、CHECK 制約)を追加。E2E は Playwright 未導入のため対象外。`note`と履歴`GET /habit-entries`は対象外(P2 未決、T-204 以降)

### T-203 Daily check-in

- mood/difficulty/note upsert
- Unit/Integration: 値域、local date、ownership
- E2E: 当日チェックイン
- 設計: Feature Spec([daily-check-in.md](specs/daily-check-in.md))と Implementation Plan([daily-check-in.md](plans/daily-check-in.md))を作成。`PUT`は全項目置換、対象日は今日から過去 7 日、3 項目すべて未設定は 422、メモは暫定 1000 文字(改行・タブのみ許可)と決定
- 実装: Domain `resolveDailyCheckIn`、Application `getDailyCheckInUseCase`/`upsertDailyCheckInUseCase`(「今日」の算出を`resolveLocalToday`へ切り出し T-202 と共有)、Infrastructure `PrismaDailyCheckInRepository`(`INSERT ... ON CONFLICT`の単一文で冪等 upsert、user 不存在は FK 違反でなく「見つからない」)、`GET/PUT /api/v1/daily-check-ins/{date}`。Migration なし(既存の制約・index で足りる)
- テスト: Unit(Domain/Application/契約/handler)と Integration(実 PostgreSQL: 往復、置換、再送、並行 6 件で 1 レコード、他ユーザーとの分離、user 不存在、mood/difficulty の CHECK)を追加。E2E は Playwright 未導入のため対象外。履歴・WAU 集計は T-204 以降

### T-204 Statistics dashboard

- streak、7/30 日成功率、空状態
- Unit: 全集計定義。Integration: query count/性能
- E2E: 記録後の反映
- 設計: Feature Spec([statistics-dashboard.md](specs/statistics-dashboard.md))と Implementation Plan([statistics-dashboard.md](plans/statistics-dashboard.md))を作成。今日の未記録は保留(分母外・ストリークを切らない)、期間は今日を含む直近 7/30 日、成功率・ストリークは習慣ごと+全体の成功率、`GET /dashboard`は`from`/`to`なしの固定集計、スコープは API+集計ロジックのみ(UI・E2E は対象外)と決定(D-13)
- 実装: Domain `calculateHabitStatistics`/`aggregateWindowStatistics`(予定機会ごとに success/missed/skipped/pending へ分類し、ストリークは success で加算・missed で 0・skipped/pending は中立、366 日まで遡る)、Application `getDashboardUseCase`(記録は習慣数に依らず 1 回の範囲取得。アーカイブ済み習慣は除外)、Infrastructure `HabitEntryRepository.listByDateRange`、`GET /api/v1/dashboard`。Migration なし
- テスト: Unit(Domain の全集計定義とシード固定の性質テスト/Application/契約/handler)と Integration(実 PostgreSQL: 範囲取得の境界・他ユーザー分離、応答全体、アーカイブ除外、問い合わせ回数が習慣数に依らず記録取得は 1 回)を追加。E2E は Playwright 未導入のため対象外

## Phase 2.5: Web UI と E2E

T-101〜T-204 は API・Domain・Application までで、ブラウザで操作できる画面と Playwright E2E は未実装である（各タスクの「E2E: Playwright 未導入のため対象外」を本 Phase で回収する）。「手動で価値が成立する記録・振り返り」を人が画面で確認できる状態にするため、AI より先に本 Phase を行う。各タスクは Standard 変更として Feature Spec と Implementation Plan を作成する。UI は既存 API(`/api/v1/*`、`/api/auth/*`)の消費側とし、業務ロジックを Presentation に持たせない。

共通事項: 第三者の書籍・アプリ・ブランドの文言、図表、配色、文章構成を複製・近似再現しない(AGENTS.md の Third-Party Content 規則)。画面文言と UI は独自に設計し、公開名称や販促表示に関わるものは human review の対象とする。

### T-211 Web UI 基盤と E2E 基盤

- 設計: UI スタック(スタイリング、コンポーネント方針、フォーム/データ取得の方式)を ADR で決定する。layout、ナビゲーション、認証済み/未認証の route 保護、エラー/空/読み込み状態の共通方針、アクセシビリティ基準(WCAG 2.2 AA を目標)を定める。ローカル用のメール受信ツールと env の扱いを定める
- 実装: UI 基盤(layout、共通コンポーネント、共通 error boundary)、`apps/web`の env 読み込みと validation、Docker Compose への Mailpit 追加(SMTP キャプチャ。アプリの DB とは独立)、Playwright 導入と`pnpm test:e2e`、fixture(架空データのみ)、CI(`pr-quality.yml`)への E2E 追加の要否判断
- テスト: 空のページ・認証ガードの E2E smoke、keyboard/focus の基本確認。Mailpit からのメール取得 helper の動作確認
- レビュー: Secret や個人データが fixture・trace・screenshot に残らないか。CI で fork PR に secret を渡さないか。`AGENTS.md`の`pnpm test:e2e`の記述を更新する
- 設計: Feature Spec([web-ui-foundation.md](specs/web-ui-foundation.md))と Implementation Plan([web-ui-foundation.md](plans/web-ui-foundation.md))、[ADR-010](adr/ADR-010-web-ui-stack.md)を作成。CSS Modules + 自前の最小コンポーネント、型付き API client + TanStack Query、保護画面は`(app)` layout で DB session を検証(`middleware`/`proxy`は DB session を検証できないため不採用)、E2E は Playwright + Mailpit、CI は secret なしの独立 job と決定(D-14)
- 実装: `apps/web`に UI 基盤(design token、Button/StateMessage/PageHeader/AppNav/SkipLink、`(public)`/`(app)` route group、`error.tsx`/`global-error.tsx`/`not-found.tsx`、`getServerEnv`)、型付き API client(path 検証、Problem Details 解釈、timeout/abort、`401`→`/login`)、Docker Compose の Mailpit、Playwright(`pnpm test:e2e`、E2E 専用 database の作り直し、`signUpAndSignIn`/Mailpit helper)、`pr-quality.yml`の`e2e` job を追加。`/login`と`/today`は暫定表示(T-212、T-215 が置き換える)。Migration・API 変更なし
- テスト: Unit(API client、path 検証と retry 判定と token 抽出の性質テスト(fast-check)、ガード、コンポーネント、env、Mailpit helper)と E2E smoke(未認証 redirect、認証済み描画、skip link と Tab 順序/focus、404、landmark/`h1`)。変異テストは Stryker 未導入のため 23 件の手動変異で確認し、生存した 2 件(再試行ボタン未接続、空 token)に対するテストを追加して全件検出。敵対的審査で error/not-found に`h1`がない欠陥を発見し修正

### T-212 認証画面

- T-101 の API を利用: signup、メール確認、login、logout、password reset の画面
- 設計: 失敗時の文言でアカウントの有無を漏らさない(enumeration 対策)、CSRF/Origin、session 切れの扱い
- Unit: フォーム validation の表示。E2E: signup → verify(Mailpit から token 取得)→ login → logout、password reset の一連(T-101 の E2E を回収)
- 設計: Feature Spec([auth-screens.md](specs/auth-screens.md))と Implementation Plan([auth-screens.md](plans/auth-screens.md))を作成。遷移元への復帰は`next`クエリ(許可リスト方式の`sanitizeNextPath`、現在の path は proxy が`x-pathname` header で渡す。proxy は認証判定をしない)、認証済みユーザーの`/login`等は`/today`へ redirect、メール確認はリンクを開くだけでは token を消費せずボタンで確認、login の失敗文言は 1 種類に統一、と決定
- 実装: `/signup`・`/login`・`/verify-email`(確認/再送)・`/password-reset`・`/password-reset/confirm`、ログアウト、フォーム部品(`TextField`/`ErrorSummary`)、Auth.js 標準 endpoint の client(`lib/auth/auth-client.ts`。成否は DB session 由来の session 応答で判定)、全 route へのセキュリティヘッダー(`frame-ancestors`、`Referrer-Policy: no-referrer`)、session 失効時の`next`+案内。Migration・API 変更なし。`docker-compose.yml`に`POSTGRES_PORT`、E2E に`E2E_POSTGRES_PORT`を追加(5432 を他のプロジェクトが使っている環境向け)
- テスト: Unit(`next-path`・`validation`・`auth-client`・`pathname-header`・ガード・フォーム部品。性質テストは fast-check)と E2E 16 件(一連の流れ、login 失敗 3 種の本文一致、登録済み email の signup、reset の一連とリンク再利用拒否、`next`/不正な`next`、認証済みの redirect、logout 後の旧 cookie 無効、入力エラーのフォーカスと`aria-*`、二重クリック、通信失敗、ヘッダー)。変異テストは Stryker 未導入のため手動 38 件で確認し、生存した変異は等価(後段の検査が同じ入力を拒否する多層防御、または型で到達不能)で、境界入力と`reason`の無視のテストを追加。敵対的審査は実装後の差分で実施

### T-213 オンボーディングとプロフィール画面

- T-102 の`GET/PATCH /me`を利用: 初回の timezone・表示名の設定、プロフィール編集
- E2E: onboarding profile(T-102 の E2E を回収)。timezone の不正値、他ユーザーの情報が見えないこと
- 設計: Feature Spec([profile-screens.md](specs/profile-screens.md))と Implementation Plan([profile-screens.md](plans/profile-screens.md))を作成。オンボーディング完了は`displayName`が`null`でないこと(Application の`hasCompletedOnboarding`に一元化)、未完了は`(app)/(onboarded)` layout が`/onboarding`へ誘導、`locale`は UI が日本語のみのため編集 UI を出さない、と決定
- 実装: `/onboarding`・`/profile`(表示名、タイムゾーン選択、週の開始曜日)、`SelectField`、ブラウザのタイムゾーンを初期提案、ナビゲーションにプロフィール追加。Migration・API 変更なし。`/today`は`(onboarded)`配下へ移動(URL は不変)
- テスト: Unit(判定関数、ガード、選択肢構築・表示名検証の性質テスト、固定文言)と E2E 8 件(誘導、未完了/完了済みの redirect、編集の永続化、入力エラー、server 拒否の固定文言、HTML 文字列、2 ユーザーの分離、未認証)。手動変異 13 件を全件検出。E2E helper は既定でオンボーディングまで済ませる

### T-214 習慣管理画面

- T-104 の`/api/v1/habits`を利用: 一覧、作成(build/reduce)、スケジュール編集、アーカイブ、更新競合(409)時の再読み込み導線
- E2E: build/reduce の CRUD(T-104 の E2E を回収)
- 設計: Feature Spec([habit-screens.md](specs/habit-screens.md))と Implementation Plan([habit-screens.md](plans/habit-screens.md))を作成。「今日」(適用開始日の既定)はプロフィールの timezone から client が算出、スケジュール変更は適用開始日を指定して新しい版を追加(遡及は server の`422`を固定文言で表示)、競合(409)は入力を保持したまま「最新の内容を読み込む」で最新へ置換、`version`は取得時点の値を必ず送る、と決定
- 実装: `/habits`(進行中/アーカイブ済み、さらに表示)・`/habits/new`・`/habits/[habitId]`(編集、スケジュール履歴、2 段階のアーカイブ)、型付き client(`lib/habits`)、nav に「習慣」。reduce は回数欄を出さず(1 固定)代わりの行動を入力。Migration・API 変更なし
- テスト: Unit(日付算出・フォーム検証・update body・エラー分類。fast-check の性質テスト)と E2E 12 件(build/reduce 作成、入力エラー、編集、遡及拒否と翌日開始の追加、2 タブの競合、アーカイブ、他ユーザーの分離と UUID でない ID、HTML 文字列、二重クリック、ページング、未認証)。手動変異 18 件を全件検出(生存 1 件にテストを追加)

### T-215 今日の記録とチェックイン画面

- T-202/T-203 の`GET /schedule/today`、`PUT /habits/{habitId}/entries/{date}`、`GET/PUT /daily-check-ins/{date}`を利用: 今日の予定、成功/未実施/skip/訂正、過去 7 日の補正、mood/difficulty/note
- E2E: 成功/未実施/skip/訂正、当日チェックイン(T-202、T-203 の E2E を回収)。再送・二重クリックで重複しないこと
- 設計: Feature Spec([today-screens.md](specs/today-screens.md))と Implementation Plan([today-screens.md](plans/today-screens.md))を作成。過去 7 日の補正のため読み取り専用の`GET /api/v1/schedule/{date}`を追加し、応答に`earliestDate`を加えて client が「7 日」を再定義しない(HENT-INV-005)、記録操作は操作の種類から`status`を決めるだけで成否判定は server、チェックインの`404`は未記録として扱う、と決定
- 実装: Application`getScheduleOnDateUseCase`(範囲検証を upsert と共有)、`/today`を記録画面に(日付選択、習慣ごとの記録・訂正・途中経過、デイリーチェックイン)。Migration なし
- テスト: Unit(日付選択肢の性質テスト、操作→body、チェックイン検証、エラーの固定文言、`getCheckIn`の 404 扱い、Application の範囲境界・timezone・他ユーザー、handler の 401/422/200)と E2E 12 件(記録と訂正、途中経過の拒否、過去日の補正、不正な date クエリ、空状態、チェックイン、未設定への置換、HTML 文字列、二重クリック、他ユーザーの分離、新規 API)。手動変異 18 件を全件検出(生存 1 件にテスト追加)。二重クリックは再描画より速い連続クリックで 2 回送られたため、同期的なロック(ref)を追加

### T-216 ダッシュボード画面

- T-204 の`GET /dashboard`を利用: ストリーク、7/30 日成功率、習慣ごとの内訳、空状態
- E2E: 記録後の反映(T-204 の E2E を回収)。数値の表現は集計定義(D-13)に一致させ、色だけに依存しない
- 設計: Feature Spec([dashboard-screen.md](specs/dashboard-screen.md))と Implementation Plan([dashboard-screen.md](plans/dashboard-screen.md))を作成。集計は server のまま client は整形のみ、成功率は整数%で`rate < 1`を 100%、`rate > 0`を 0%にしない、`null`は「まだ集計できません」と 0% を区別、ストリークは単位を「回」とし控えめな文言(復帰率の仮説)、集計定義を`details`で説明、と決定
- 実装: `/dashboard`(全体の直近 7/30 日、習慣ごとの内訳、数値の見方)、整形(`lib/dashboard/format.ts`)、nav に「ダッシュボード」、T-215 の記録成功時に`["dashboard"]`を無効化。Migration・API 変更なし
- テスト: Unit(整形の境界と性質テスト)と E2E 7 件(記録後の反映 33% → 43% と連続回数、スキップは分母外、空状態、確定前の習慣は 0% でなく「まだ集計できません」、HTML 文字列と説明、他ユーザーの分離、未認証)。手動変異 7 件を全件検出

### T-217 通知設定画面

- T-401 の`/api/v1/notification-settings`を利用: 送信時刻、quiet hours、停止と再開
- E2E: 設定と停止(T-401 の E2E を回収)。メール送信自体は T-402 のスコープ

## Phase 3: 週次レビューと AI

### T-301 Weekly review

- snapshot、draft/complete、対象週
- Unit: 集計 snapshot。Integration: 一意性/再実行
- E2E: review 作成・確定
- 設計: Feature Spec([weekly-review.md](specs/weekly-review.md))と Implementation Plan([weekly-review.md](plans/weekly-review.md))を作成。週の開始日はプロフィールの`weekStartsOn`(既定は月曜)、レビューは終了済みで直近 52 週以内の週を`POST`で明示作成(同じ週は冪等)、振り返りは 1 つの自由記述で確定後は編集不可、スコープは API+集計ロジックのみ(UI・E2E・AI 分析は対象外)と決定(D-15)
- 実装: Domain `buildWeeklyReviewSummary`/`checkReviewableWeek`/`normalizeWeeklyReflection`(結果分類は T-204 の`statistics.ts`を`outcomeOf`/`calculateRangeStatistics`として共有)、Application `createWeeklyReviewUseCase`/`getWeeklyReviewUseCase`/`listWeeklyReviewsUseCase`/`updateWeeklyReviewUseCase`(保存済みスナップショットは契約 schema で読み出し時に検証)、Infrastructure `PrismaWeeklyReviewRepository`(`INSERT ... ON CONFLICT DO NOTHING`の単一文で冪等作成、`WHERE status = 'draft'`付きの単一`UPDATE`で原子的に更新・確定)と`DailyCheckInRepository.listByDateRange`、`GET/POST /api/v1/weekly-reviews`・`GET/PATCH /api/v1/weekly-reviews/{reviewId}`。Migration は CHECK 制約の追加のみ(expand)
- テスト: Unit(Domain の集計・正規化とシード固定の性質テスト/Application/契約/handler)と Integration(実 PostgreSQL: 往復、再作成でスナップショット不変、並行作成 6 件で 1 行・確定 6 件で 1 回のみ成功、他ユーザー分離、CHECK 制約、fresh と upgrade の Migration)を追加。E2E は Playwright 未導入のため対象外。AI 分析(`/analysis`)は T-303/T-305

### T-302 AI contracts/fake adapter

- versioned input/output schema、AiCoachPort、fake、safety/fallback、第三者コンテンツvalidator、権利資料allowlist契約
- Unit: valid/invalid/refusal/oversize output、転載・翻訳・文体模倣・ブランド誤認・権利疑義fallback
- 設計: Feature Spec([ai-contracts.md](specs/ai-contracts.md))と Implementation Plan([ai-contracts.md](plans/ai-contracts.md))を作成。範囲は contract 層のみ(DB・HTTP・実 provider・queue は対象外)、false positive 閾値・golden dataset の reviewer・human review queue は T-505 へ送り、AI 公開 feature flag の停止で代替すると決定
- 実装: Contracts `ai.ts`(入出力 `V1` schema、`contentSafety`)、Domain `evaluateRightsUse`(deny by default の権利判定)、Application `AiCoachPort`・`validateGeneratedContent`(決定論的 validator)・`inspectGenerationRequest`(事前検査)・versioned fallback・`generateSafeCoaching`(flag → 事前検査 → provider(timeout、3 attempt の backoff + jitter)→ schema 検証 → validator → 再生成 1 回 → fail-closed fallback)・`admitCorpusSource`・`AiAuditSinkPort`(本文を持たない監査)、Infrastructure `createFakeAiCoach`・`createInMemoryRightsRegistry`。`@habit-app/application` が `@habit-app/contracts` に依存する
- テスト: Unit(schema、権利判定、validator の各 reason code と adversarial/一般助言 fixture、pipeline 全経路、retry/timeout、監査に本文がないこと、fake adapter)を追加。DB・HTTP を追加しないため Integration/E2E は対象外

### T-303 AI queue pipeline

- SQS producer、Lambda consumer、attempt、DLQ、idempotency
- Integration: timeout/429/5xx/partial batch/duplicate
- E2E: fake provider で pending → completed
- 設計: Feature Spec([ai-queue-pipeline.md](specs/ai-queue-pipeline.md))と Implementation Plan([ai-queue-pipeline.md](plans/ai-queue-pipeline.md))を作成。範囲は queue port・worker・`ai_jobs` 状態管理・`POST /weekly-reviews/{id}/analysis`(202)・`GET /ai-jobs/{id}` まで。実 SQS adapter・Terraform・実 provider は対象外(T-501、ADR-003)、分析の中身は T-305(D-16)
- 実装: Domain `decideAiJobClaim`/`canonicalJson`、Application `requestWeeklyAnalysisUseCase`/`getAiJobUseCase`/`processAiJobUseCase`/`handleAiJobMessages`(SQS 形式の部分バッチ失敗)と入力の最小化・fingerprint、Infrastructure `PrismaAiJobRepository`(`ON CONFLICT DO NOTHING` の冪等作成、単一文の claim と lease、確定と attempt を 1 transaction)・inline queue(ローカル/E2E 用)、`apps/workers` の SQS handler、Config(`AI_QUEUE_DRIVER`/`AI_PROVIDER`/`AI_PUBLICATION_ENABLED`。本番で `inline` を拒否)。Migration は unique index と CHECK の追加のみ(expand)
- テスト: Unit(状態遷移と canonical JSON の性質テスト、入力の最小化、request/process/handler の全分岐、重複配送、受信上限、契約、HTTP、Config)と Integration(実 PostgreSQL: 並行作成 6 件で 1 行・並行 claim 6 件で 1 件・lease 切れの引き継ぎ、確定の競合、CHECK 制約、POST→処理→GET の一周、fresh と upgrade の Migration)を追加。E2E は UI 未実装のため対象外

### T-304 Habit design coaching

- structured design proposal、確認 UI、選択適用
- Unit: proposal-to-command validation
- E2E: 提案を編集して採用、AI failure

### T-305 Weekly improvement coaching

- evidence-based analysis、規則 fallback、結果 UI
- Eval: golden dataset。E2E: 成功/fallback

## Phase 4: 通知・管理・削除

### T-401 Notification preferences

- opt-in、quiet hours、timezone、unsubscribe
- Unit/Integration/E2E: 設定と停止
- 設計: Feature Spec([notification-preferences.md](specs/notification-preferences.md))と Implementation Plan([notification-preferences.md](plans/notification-preferences.md))を作成。ユーザー単位の設定のみ(習慣ごとの通知は対象外)、既定は無効(opt-in)、quiet hours は暫定で 22:00〜07:00・ユーザーの timezone 基準、配信停止はログイン後の設定 OFF のみ(メール内ワンクリック unsubscribe は T-402)と決定
- 実装: Domain `resolveNotificationPreference`/`isWithinQuietHours`、Application `getNotificationSettingsUseCase`/`upsertNotificationSettingsUseCase`、Infrastructure `PrismaNotificationSettingsRepository`(部分 unique index に対する `INSERT ... ON CONFLICT` の単一文で冪等 upsert)、`GET/PUT /api/v1/notification-settings`。Migration は unique index と CHECK の追加のみ(expand)
- テスト: Unit(Domain/Application/契約/handler)と Integration(実 PostgreSQL: 往復、置換、停止と再開、並行 6 件で 1 行、他ユーザーとの分離、CHECK、fresh と upgrade の Migration)を追加。E2E は Playwright 未導入のため対象外。メール送信・dedupe・unsubscribe リンクは T-402

### T-402 Notification scheduler/delivery

- window scan、dedupe、SES、bounce/complaint
- Integration: 重複/期限切れ/retry/DLQ
- 設計: Feature Spec([notification-delivery.md](specs/notification-delivery.md))と Implementation Plan([notification-delivery.md](plans/notification-delivery.md))を作成。5 分間隔のスケジューラが有効な設定を走査して配送を `pending` で作り(`(設定, ローカル日)` の dedupe)、SQS 経由のワーカーが claim・判定・送信する。許容遅延 60 分、再試行は DB 上の状態(最大 5 回、exponential backoff + full jitter)、予期しない例外は SQS の redrive で DLQ へ。当日の予定がすべて記録済みなら送らず、本文は個人情報を含まない定型文。メール内の署名付きリンク(RFC 8058)でワンクリック配信停止、Permanent bounce/complaint は `email_suppressions` で永久停止と決定。差分が大きいため 2 本の PR(PR-A: コア、PR-B: AWS 接続・Lambda・Terraform)に分ける
- 実装(PR-A): Domain `resolveReminderSlot`(DST の gap/fall-back を解決)・配送の定数と判定、Application `scheduleDueRemindersUseCase`/`deliverReminderUseCase`/`handleEmailFeedbackUseCase`/`unsubscribeUseCase` と各 port、tracking の公開 API `hasUnrecordedScheduledHabitsUseCase`、Infrastructure の Prisma repository 群と HMAC 署名 token、`GET/POST /api/v1/notification-unsubscribe`。Migration は列・CHECK・index・`email_suppressions` の追加のみ(expand)
- テスト(PR-A): Unit(スロット変換の DST 遷移日を全分で検証するプロパティテスト、判定順序、再試行、token の改ざん検知)と Integration(実 PostgreSQL: dedupe、並行 claim 6 件で 1 回、終端の不変、CHECK、CASCADE、fresh と upgrade の Migration)を追加。E2E は Playwright 未導入のため対象外。SES/SQS adapter・Lambda・Terraform は PR-B
- 実装(PR-B): Infrastructure の SES adapter(`SesReminderSender`。エラーを transient/permanent に分類、timeout は `AbortSignal`、SDK の再試行は無効)・SQS producer(10 件ごとに batch、部分失敗は未投入として返す)・Secrets Manager reader(キャッシュ、値・ARN をエラーに含めない)、`@habit-app/infrastructure/worker`(Auth.js を含まない Lambda 用の入口)、`packages/config` の `parseWorkerEnv`、`apps/workers` の Lambda handler 3 本(scheduler / delivery / feedback。SQS の `batchItemFailures`、不正 message は破棄、件数のみのログ、Lambda ごとに必要な設定・権限だけを構築)。Terraform は `infra/modules/email`(SES identity・DKIM・configuration set・bounce/complaint 用 SNS)、`infra/modules/queue-worker`(SQS + DLQ、Lambda、最小権限 IAM、EventBridge Scheduler、アラーム、署名鍵 secret の器)、`infra/environments/dev`(最小構成)。`.terraform.lock.hcl` を commit 対象にし、CI に `terraform fmt -check`/`validate` の job を追加。ADR-011 と Runbook(`docs/runbooks/notification-delivery.md`)を追加
- テスト(PR-B): fake HTTP server(SES: 200/429/5xx/4xx/timeout/切断/ID なし応答とヘッダー・本文、SQS: batch 分割/部分失敗/障害、Secrets: キャッシュ/失敗/timeout)、Lambda handler(部分失敗、不正 message の破棄、Feature Flag、ログに個人情報を出さない)、composition root の結合(実 PostgreSQL + fake の SES/SQS で scheduler → delivery → feedback、重複しない)。Terraform は `fmt`/`validate` のみ。`plan`・policy as code・tflint は認証情報と共通基盤が必要なため T-501 で実施

### T-403 Minimal admin

- admin MFA/role、read-only operation view、audit
- Integration/E2E: member 拒否、admin access、監査
- 設計: Feature Spec([minimal-admin.md](specs/minimal-admin.md))と Implementation Plan([minimal-admin.md](plans/minimal-admin.md))を作成。管理者は別表 `admin_users` + 運用スクリプトで付与(API/UI に経路なし)、既存の session + TOTP の追加認証(MFA は session 単位で 30 分、リカバリーコード 8 個、失敗 5 回で 15 分ロック)、Member には管理 route を 404 で秘匿、検索は email 完全一致 + マスク表示、閲覧は監査を先に追記(fail closed)、`audit_logs` は DB で追記専用と決定。差分が大きいため 2 本の PR(PR-A: バックエンド、PR-B: 画面と E2E)に分ける
- 実装(PR-A): Domain `admin`(MFA の有効期限・ロック・コード正規化・マスク)、Application(`authorizeAdmin`、`verifyAdminMfaUseCase`、閲覧 4 本、付与/無効化/MFA 再発行)と各 port、Infrastructure(TOTP は RFC 6238 の公式ベクトルで検証、AES-256-GCM の `SecretBox`、リカバリーコード、IP の HMAC、Prisma repository 群、session の `findSessionDetails`)、`/api/v1/admin/*`(6 本 + 未定義 path の catch-all)、運用スクリプト `pnpm admin:grant|admin:disable|admin:reset-mfa`(`tsx`)。Migration は新テーブル 2・`sessions.mfa_verified_at`・`audit_logs` の追記専用化(expand のみ)
- テスト(PR-A): Unit(TOTP の公式ベクトル、暗号の改ざん検知、判定の境界、認可の振り分けと Member への応答の同一性、監査が先)と Integration(実 PostgreSQL: 失敗カウントの原子性、同じコードの並行使用で成功 1 件、ロック、リカバリーコードの単回使用、追記専用、閲覧の allowlist、スクリプトの子プロセス実行、fresh と upgrade の Migration)を追加。画面と E2E は PR-B
- 設計(PR-B): Feature Spec([admin-screens.md](specs/admin-screens.md))を作成。Member には管理画面を通常の 404 と同じ表示で秘匿、MFA 未検証の Admin は `/admin/mfa?next=…` へ誘導(`next` は `/admin` 配下の許可リスト)、検索の email は URL・storage・queryKey に載せない(`useMutation`)、日時は UTC 固定書式、取得データは `gcTime: 0`・`noindex` と決定
- 実装(PR-B): `(admin)` route group(共通 layout が `authorizeAdmin` で 404、`(verified)` layout が MFA 未検証を検証画面へ)、画面 6 本(`/admin/mfa`、`/admin`、`/admin/users`、`/admin/users/[publicId]`、`/admin/notifications`、`/admin/ai-jobs`)、管理用ナビゲーション、型付き API client。API・DB の変更なし
- テスト(PR-B): Unit(`next` の許可リストと冪等性の性質テスト、ガードの振り分け、エラー分類、日時書式、API client の path/body)と Playwright E2E 9 シナリオ(Member 404 の同一性、未認証、MFA 誘導と誤コード、リカバリーコードの単回使用、検索のマスクと email の非残存と監査、失敗一覧と絞り込み、ロック、期限切れの再検証、無効化)。Admin は本物の `pnpm admin:grant` で作り、TOTP は独立実装で生成する

### T-404 Export/account deletion

- 再認証、async export、猶予期間、cascade/provider cleanup
- Integration/E2E: 他人 export 拒否、削除完了

### T-405 Auth email via SES

- 認証メール(email 確認・パスワード再設定)の本番送信。`EmailSenderPort`(auth)の SES 実装 `SesAuthEmailSender` を追加し、`AUTH_EMAIL_SENDER=ses` を本番で使えるようにする(T-101 は本番で `smtp` を禁止している)
- T-402 の SES adapter・identity・configuration set・Terraform モジュールを再利用する。差分は、認証メールが取引メールであること(通知の suppression/配信停止の対象にするか、bounce/complaint の扱い、`List-Unsubscribe` を付けないこと)、web(ECS)側の送信権限と署名、token を URL に含むメールのログ・保持の扱い
- Unit/Integration: fake HTTP server で timeout/429/5xx/永続エラー、本文に token が含まれてもログに出ない、enumeration を起こさない応答の維持(AUTH-INV-002)。E2E: ローカルは Mailpit のまま(本番は SES)
- 依存: T-402(SES 基盤)、ADR-005(送信ドメインの確定)、T-501(ECS task role への SES 権限)。T-502(本番基盤)・T-505(限定 beta)の前提
- Exit: 本番相当の環境(staging、SES sandbox の verified address)で signup → email 確認 → password reset が通る

## Phase 5: Production readiness

### T-501 Terraform dev/staging

- network、ECS、RDS、SQS/Lambda、Secrets、observability
- Test: fmt/validate/lint/policy/plan

### T-502 Production infrastructure

- account separation、Multi-AZ、backup/PITR、WAF、alarms
- Test: restore drill、failover/runbook rehearsal
- 前提: T-405(認証メールの SES 送信)。これが無いと本番で signup の確認メールが送れない

### T-503 Deployment pipeline

- OIDC、artifact promotion、migration sequencing、rollback
- Test: staging deploy、smoke、rollback rehearsal

### T-504 Security/performance/accessibility gate

- threat model、authorization matrix、load test、WCAG audit
- Exit: P0/P1 security findings 0、SLO baseline 達成

### T-505 Limited beta

- feature flags、support/incident flow、cost budget、feedback collection
- Exit: 2〜4 週の品質・継続率を評価して一般公開判断

## 推奨リリース順

最初の縦切りは T-001〜T-005 → T-101〜T-104 → T-201〜T-204 → T-211〜T-217(Web UI と E2E)。AI より先に「手動で価値が成立する記録・振り返り」を、画面で操作できる状態まで完成させる。その後 T-301〜T-305 で AI の増分価値を測る。
