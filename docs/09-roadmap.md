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
- 未実装(Spec の Out of Scope/Accepted Risks): `Idempotency-Key`、rate limit、`localTime`、構造化ログ、OpenAPI 生成。文字数上限は P2 未決のため暫定値
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

## Phase 3: 週次レビューと AI

### T-301 Weekly review

- snapshot、draft/complete、対象週
- Unit: 集計 snapshot。Integration: 一意性/再実行
- E2E: review 作成・確定

### T-302 AI contracts/fake adapter

- versioned input/output schema、AiCoachPort、fake、safety/fallback、第三者コンテンツvalidator、権利資料allowlist契約
- Unit: valid/invalid/refusal/oversize output、転載・翻訳・文体模倣・ブランド誤認・権利疑義fallback

### T-303 AI queue pipeline

- SQS producer、Lambda consumer、attempt、DLQ、idempotency
- Integration: timeout/429/5xx/partial batch/duplicate
- E2E: fake provider で pending → completed

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

### T-402 Notification scheduler/delivery

- window scan、dedupe、SES、bounce/complaint
- Integration: 重複/期限切れ/retry/DLQ

### T-403 Minimal admin

- admin MFA/role、read-only operation view、audit
- Integration/E2E: member 拒否、admin access、監査

### T-404 Export/account deletion

- 再認証、async export、猶予期間、cascade/provider cleanup
- Integration/E2E: 他人 export 拒否、削除完了

## Phase 5: Production readiness

### T-501 Terraform dev/staging

- network、ECS、RDS、SQS/Lambda、Secrets、observability
- Test: fmt/validate/lint/policy/plan

### T-502 Production infrastructure

- account separation、Multi-AZ、backup/PITR、WAF、alarms
- Test: restore drill、failover/runbook rehearsal

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

最初の縦切りは T-001〜T-005 → T-101〜T-104 → T-201〜T-204。AI より先に「手動で価値が成立する記録・振り返り」を完成させる。その後 T-301〜T-305 で AI の増分価値を測る。
