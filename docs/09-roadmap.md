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

- 設計: required checks、cache、artifact、OIDC の境界
- 実装: PR quality workflow と security scan
- テスト: 意図的な lint/test failure が merge を止める
- レビュー: fork PR に secret を渡していないか

## Phase 1: Identity と習慣 CRUD

### T-101 Auth adapter と session

- Auth.js（NextAuth）integration、Credentials（email+password）+ Google/GitHub OAuth、callback/session/logout、admin TOTP 2FA
- Unit: session mapping。Integration: unauthorized/expired/rotation
- E2E: signup/login/logout/password reset

### T-102 User/Profile

- Domain/Application、`GET/PATCH /me`、timezone validation
- Unit: policy/value object。Integration: persistence/ownership
- E2E: onboarding profile

### T-103 Habit Domain

- `Habit`, `HabitKind`, `ScheduleVersion` と invariant
- Unit: build/reduce、schedule、編集有効日

### T-104 Habit repository/use cases/API

- create/list/get/update/archive、cursor、optimistic lock
- Integration: constraint、IDOR、409、pagination
- E2E: build/reduce CRUD

## Phase 2: Tracking と可視化

### T-201 Schedule calculation

- タイムゾーン/DST 対応の予定機会生成
- Unit/property test: 境界日、非予定日、version 切替

### T-202 Habit entry

- today query、entry upsert、idempotency
- Integration: duplicate、concurrency、ownership
- E2E: 成功/未実施/skip/訂正

### T-203 Daily check-in

- mood/difficulty/note upsert
- Unit/Integration: 値域、local date、ownership
- E2E: 当日チェックイン

### T-204 Statistics dashboard

- streak、7/30 日成功率、空状態
- Unit: 全集計定義。Integration: query count/性能
- E2E: 記録後の反映

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
