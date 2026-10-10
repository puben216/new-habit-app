# AI Queue Pipeline Implementation Plan

Status: Done
Owner: TBD
Last updated: 2026-10-09
Spec: [../specs/ai-queue-pipeline.md](../specs/ai-queue-pipeline.md)
Change classification: Standard

## Approach

T-301/T-302 と同じ層構成で縦に薄く実装する。実 SQS は使わず、queue は port の裏に隠し、in-memory(テスト)と inline(ローカル/E2E)の adapter で動かす。

1. **Domain**(`packages/domain/src/ai/`): `ai-job.ts` — `AiJobStatus`/`AI_JOB_STATUSES`、`isTerminalAiJobStatus`、`decideAiJobClaim`(status と lease 経過から claim/in_progress/finished を返す純粋関数)、`canonicalJson`(キーを辞書順に整列した決定的な JSON 文字列)。
2. **Contracts**(`packages/contracts/src/ai-job.ts`): `aiJobMessageV1Schema`(`{ v: 1, jobId }`、strict)、`aiJobResultV1Schema`、`aiJobResponseSchema`、`aiJobIdParamSchema`。
3. **Application**(`packages/application/src/ai/`):
   - `job-ports.ts`: `AiJobRepositoryPort`(`createOrGet`、`countActive`、`findById`(actor)、`claim`、`complete`、`release`)、`AiJobQueuePort`(`enqueue(message)`)。
   - `weekly-input.ts`: `buildWeeklyImprovementInput`(最小化・上限・`subjectId`・schema 検証)、`fingerprintInput`(`node:crypto` の SHA-256)。
   - `job-use-cases.ts`: `requestWeeklyAnalysisUseCase`(レビュー取得・`completed` 検証・入力組み立て・createOrGet・投入・上限)、`getAiJobUseCase`、`processAiJobUseCase`(claim → 入力再構築 → `generateSafeCoaching` → 確定、失敗時の release/`worker_exhausted`)。
   - `job-handler.ts`: `handleAiJobMessages`(SQS 形式 record の parse、`processAiJobUseCase` 呼び出し、`batchItemFailures` の組み立て)。
4. **Infrastructure**(`packages/infrastructure/src/ai/`): `prisma-ai-job-repository.ts`(`INSERT ... ON CONFLICT DO NOTHING`、claim の単一 `UPDATE`(DB 時刻で lease 判定)、確定 + attempt を 1 transaction)、`ai-job-wiring.ts`(web/workers 共通の配線)、`inline-ai-job-queue.ts`、`noop-ai-audit-sink.ts`。
5. **Migration**: `20261009000000_t303_ai_job_constraints`(unique index + CHECK)。
6. **Presentation**(`apps/web`): `ai-job-handlers.ts`、`ai-job-container.ts`、`app/api/v1/weekly-reviews/[reviewId]/analysis/route.ts`(POST)、`app/api/v1/ai-jobs/[jobId]/route.ts`(GET)。
7. **Worker**(`apps/workers`): `src/handlers/ai-coaching.ts`(SQS event → `handleAiJobMessages`)と composition root。`placeholder.ts` は残す。
8. **Config**(`packages/config`): `AI_QUEUE_DRIVER`(`inline|sqs`、既定 `inline`)、`AI_PROVIDER`(`fake`、既定)、`AI_PUBLICATION_ENABLED`(既定 false)。本番で `inline` を拒否し、fake のままの公開有効化を拒否。worker 用の `parseWorkerEnv`(認証・メールの Secret を要求しない)。`.env.example` を更新。
9. **文書**: `docs/04`、`docs/05`、`docs/06`、`docs/09`、`docs/10`(D-16)。

## Impact Analysis

| Area           | Change                                                                       | Risk                                         |
| -------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Domain         | `ai/` に純粋関数を追加(既存は変更しない)                                     | 低                                           |
| Application    | `ai/` に port・use case・handler を追加。`generateSafeCoaching` は変更しない | 中(状態遷移と競合を Unit/Integration で検証) |
| Infrastructure | 新 repository と queue adapter                                               | 中(claim・確定の原子性を Integration で検証) |
| Presentation   | 新規 route 2 件                                                              | 低                                           |
| Worker         | handler と composition root を追加                                           | 低(業務ロジックは Application)               |
| Database       | unique index と CHECK の追加(expand)                                         | 低(既存行なし前提。fresh/upgrade で検証)     |
| Config         | env 3 件の追加(既定値あり、本番拒否)                                         | 低(`env.test.ts` で検証)                     |
| API/Event      | 新規 endpoint 2 件、queue message 契約                                       | 低                                           |
| AWS/Terraform  | 変更なし(T-501)                                                              | N/A                                          |
| Observability  | 変更なし(要件のみ Spec に記載)                                               | N/A                                          |

## Interfaces and Contracts

- Domain: `AiJobStatus`、`isTerminalAiJobStatus(status)`、`decideAiJobClaim({ status, leaseExpired })`、`canonicalJson(value)`。
- Application:
  - `AiJobRepositoryPort`(すべて user ID を条件に含む。`claim` は job の外部 ID のみで引き、job の `userId` を返す):
    - `createOrGet({ actorUserId, kind, subjectType, subjectPublicId, promptVersion, outputSchemaVersion, provider, model, inputFingerprint, now }): Promise<{ job, created } | null>`(user 不存在は null)
    - `countActive({ actorUserId }): Promise<number>`
    - `findById({ actorUserId, jobId }): Promise<AiJobRecord | null>`
    - `claim({ jobId, leaseSeconds }): Promise<ClaimResult>`(`claimed` / `not_found` / `finished` / `in_progress`)
    - `complete({ jobId, status, model, result | failureCode, attempt }): Promise<'completed' | 'lost'>`
    - `release({ jobId }): Promise<void>`(`running → queued`)
  - `AiJobQueuePort.enqueue(message: { v: 1; jobId: string }): Promise<void>`。
  - `requestWeeklyAnalysisUseCase(deps, { actorUserId, reviewId })`、`getAiJobUseCase`、`processAiJobUseCase(deps, { jobId, receiveCount })`、`handleAiJobMessages(deps, { Records })`。
- Contracts / HTTP / queue message: Spec の API and Events 節のとおり。

## Data Migration

- Expand: unique index と CHECK を追加(Spec Data and Migration 節)。
- Backfill/Switch/Contract: N/A(`ai_jobs` は T-303 以前にアプリが書き込んでおらず既存行がない前提。適用前に件数 0 を確認する)。
- Rollback/forward fix: 制約・index を drop する forward migration、またはアプリの revert。
- 検証: fresh DB と、直前 migration までの既存 schema からの upgrade(既存行ありで適用できること)の両方。

## Security Review

- Authentication/authorization: API は session の actor を全 query に渡す。worker は job の `user_id` を actor とする。他人は 404。
- PII/secrets/logging: queue message は `jobId` のみ。provider へ送る入力は最小化。入力・`reflection`・生成本文・message 本文をログに出さない。fixture は架空データのみ。
- CSRF/Content-Type/size: POST は Origin 検証。body は不要だが、与えられた場合は上限付きで読み、strict に検証する。
- Abuse controls: 同時実行中 job は 1 ユーザー 3 件、同一入力は 1 job。
- SQL: Prisma の型付き query と `$queryRaw` のタグ付きテンプレートのみ。
- Config: 本番で `inline` と、fake のままの公開有効化を拒否(誤配備の防止)。worker は `@habit-app/infrastructure/worker` だけを import し、不要な依存(next-auth)を持ち込まない。

## Test Plan

| Requirement      | Test level  | Planned test                                                                                                                                                         |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状態遷移         | Unit        | `ai-job.test.ts`(domain): `decideAiJobClaim` の全組合せ、`canonicalJson`(キー順不問・入れ子・配列順維持・性質テスト)                                                 |
| AJOB-002         | Unit        | `weekly-input.test.ts`: 最小化(ID・email・purpose・メモを含まない)、10 件上限、アーカイブ済み習慣、fingerprint(subjectId 非依存・変更で変わる)                       |
| AJOB-001         | Unit        | `ai-job.test.ts`(application): 新規/既存/draft/他人/上限/再投入/queue 失敗/入力不正                                                                                  |
| AJOB-003/004     | Unit        | `process-ai-job.test.ts`: 正常、重複配送で provider 1 回、claim の各分岐、provider 失敗→fallback、flag 無効、再キュー、`worker_exhausted`、subject 消失、確定の lost |
| バッチ           | Unit        | `ai-job-handler.test.ts`: 部分失敗、不正 JSON/schema、重複 record、空 batch、receiveCount の受け渡し                                                                 |
| 契約             | Unit        | `contracts/ai-job.test.ts`: message(strict)、result、response、ID                                                                                                    |
| HTTP             | Unit        | `ai-job-handlers.test.ts`: 202/200/401/403/404/409/422/429/503、内部情報を含まない                                                                                   |
| Config           | Unit        | `env.test.ts`: 既定値、本番で `inline` を拒否、fake のままの公開有効化を拒否、不正値、`parseWorkerEnv`                                                               |
| Worker handler   | Unit        | `apps/workers/src/handlers/ai-coaching.test.ts`: SQS event 形式の変換と `batchItemFailures`                                                                          |
| AJOB-INV-002/003 | Integration | 並行 `createOrGet` 6 件で 1 行・`created` 1 件、並行 `claim` 6 件で 1 件のみ、lease 切れの引き継ぎ                                                                   |
| AJOB-INV-004/005 | Integration | 確定の往復と attempt 記録、終端の不変、CHECK 制約、確定の競合(lost)                                                                                                  |
| パイプライン     | Integration | inline queue + 実 DB + fake provider で POST→処理→GET が succeeded、provider 失敗で fallback、他ユーザーの job は not found                                          |
| Migration        | Integration | fresh と upgrade(既存行あり)の両方で制約が働く                                                                                                                       |

テスト品質の 3 観点(プロパティベース/変異確認/敵対的審査)を実施し、結果を完了報告に記す。

## Rollout and Operations

- Feature Flag: `AI_PUBLICATION_ENABLED`(既定 false)。
- Deployment order: Migration(後方互換)→ アプリ。実 queue/Lambda の配備は T-501。
- Metrics/alarms: 要件のみ(Spec)。実装は T-501。
- Rollback trigger and procedure: flag の停止、またはアプリの revert(制約は残して問題ない)。

## Task Breakdown

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Domain: `ai-job.ts` + Unit Test
3. Contracts: schema + Unit Test
4. Config: env + Unit Test
5. Application: port、入力組み立て、use case、handler、fake、Unit Test
6. Migration + Infrastructure: repository、queue adapter、Integration Test
7. Presentation: handler、container、route + Unit Test
8. Worker: SQS handler、composition root + Unit Test
9. 文書更新(`docs/04`、`05`、`06`、`09`、`10`、`.env.example`)
10. 品質コマンド一式(`test:integration` を含む)の実行、セルフレビュー

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## Dependencies

- 先行 task: T-301(週次レビュー)、T-302(`generateSafeCoaching`、fake provider、契約 schema)、T-102(プロフィール不要)、T-202/T-104(習慣の取得)。いずれも main に merge 済み。
- ADR 依存: ADR-003(provider は暫定。fake のみ)。外部権限、AWS: なし。

## Risks

| Risk                                           | Mitigation                                                                                            | Owner |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----- |
| 並行実行・重複配送で provider が多重に呼ばれる | DB の単一文 claim と lease、並行 6 件の Integration Test、重複配送の Unit Test                        | TBD   |
| lease より長い実行で二重実行になる             | 確定を `WHERE status = 'running'` と attempt の unique で無効化。lease を Lambda timeout より十分長く | TBD   |
| 実 SQS との差異(順序・重複・visibility)        | message 契約と SQS event 形式の handler で吸収し、at-least-once・順不同を前提にテスト。実接続は T-501 | TBD   |
| inline queue が本番に紛れる                    | Config で本番の `inline` と fake のままの公開有効化を拒否し `env.test.ts` で検証                      | TBD   |
| 入力に PII が混ざる                            | 組み立てを 1 関数に集約し、含めない項目を Unit Test で検証                                            | TBD   |

## Start Conditions

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(ADR-003 は proposed だが fake adapter のみを対象とし、実 provider は対象外)
- [x] API/event契約がレビュー済み、またはN/A(Spec の API and Events 節)
- [x] Migration方針がレビュー済み、またはN/A(Spec の Data and Migration 節)
- [x] 認可・データ保護方針がレビュー済み(Security and Privacy 節)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、`createFakeAiCoach`)
- [x] 依存taskが完了している(T-301/T-302 は main に merge 済み)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
