# AI Queue Pipeline Spec

Status: Ready
Owner: TBD
Last updated: 2026-10-09
Change classification: Standard
Roadmap Task: T-303

## Goal

確定済みの週次レビュー(T-301)に対する AI 分析を、リクエストを待たせずに非同期で生成できるようにする。`POST /weekly-reviews/{reviewId}/analysis` が `ai_jobs` を作成して 202 を返し、worker が queue 経由で `generateSafeCoaching`(T-302)を実行して結果(または規則ベースの fallback)を保存し、`GET /ai-jobs/{jobId}` で `queued → running → succeeded/fallback/failed` を確認できる。T-304(習慣設計)・T-305(週次改善の中身)が同じ基盤を使う。

## Success Metrics

- 同じ入力(週次レビュー・prompt version・入力 fingerprint)で `POST` を何度・並行して呼んでも `ai_jobs` は 1 件で、provider は 1 件の job につき多重実行されない(Integration Test: 並行 6 件)。
- 同じ queue message が重複配送されても、job の結果は 1 回だけ確定し、provider の呼び出し回数が増えない(Unit/Integration Test)。
- batch の一部が失敗しても、成功した record は再配送されない(`batchItemFailures` に失敗分のみ。Unit Test)。
- provider の障害・timeout・不正出力・安全性拒否のいずれでも、job は `fallback` で終わり、ユーザーに未検証の本文を返さない(T-302 の fail closed を継承。Unit Test)。
- queue message と通常ログに、入力データ・自由記述・生成本文・email を含めない(message は `jobId` のみ。Unit Test で message 内容を検証)。
- fake provider で `queued → succeeded` が worker 経由で完了する(Integration Test)。

## Scope

- Domain(ai): `AiJobStatus` と状態遷移(`decideAiJobClaim` など)、入力 fingerprint の正規化(canonical JSON)。
- Application(ai): `AiJobRepositoryPort`、`AiJobQueuePort`、`requestWeeklyAnalysisUseCase`、`getAiJobUseCase`、`processAiJobUseCase`(worker の本体)、週次入力の組み立て(`buildWeeklyImprovementInput`)、`handleAiJobMessages`(SQS 形式の batch 処理と部分失敗)。
- Infrastructure: `PrismaAiJobRepository`(claim・確定・attempt 記録)、`createAiJobProcessDeps`(web/workers 共通の配線)、`createInlineAiJobQueue`(ローカル/E2E 用。同一プロセスで handler を呼ぶ)、`createNoopAiAuditSink`。
- Migration: `ai_jobs` の冪等 unique index と CHECK 制約の追加(expand)。
- Contracts: queue message schema、API の request/response schema、job result schema。
- Presentation: `POST /api/v1/weekly-reviews/{reviewId}/analysis`、`GET /api/v1/ai-jobs/{jobId}`。
- Worker: `apps/workers/src/handlers/ai-coaching.ts`(SQS event adapter。業務ロジックは持たない)と composition root。worker は `@habit-app/infrastructure/worker`(next-auth 等を含まない専用の公開面)だけを使う。
- Config: `AI_QUEUE_DRIVER`、`AI_PROVIDER`、`AI_PUBLICATION_ENABLED`(本番で `inline` を許可せず、`fake` のまま公開を有効にできない)。worker 用に認証・メールの Secret を要求しない `parseWorkerEnv` を追加する。
- 文書: `docs/04`、`docs/05`、`docs/06`、`docs/09`、`docs/10`(D-16)、`.env.example`。

## Out of Scope

- 実 SQS adapter(AWS SDK)、Lambda の配備、queue/DLQ/alarm の Terraform、reserved concurrency と visibility timeout の設定(T-501。本 Spec は設定すべき値の要件のみ「Observability and Operations」に記す)。
- 実 provider(OpenAI/Claude)の adapter(ADR-003。fake のみ)。
- 分析の中身(根拠付き観測、週次集計からの規則ベース fallback、結果 UI、提案の適用。T-305)。本 Spec の fallback は T-302 の汎用定型文。
- `POST /coaching/habit-designs`(T-304)、`POST /coaching-suggestions/{id}/apply`。
- ユーザー単位・組織単位の rate limit とコスト上限の本実装、circuit breaker(同時実行中 job 数の上限のみ実装。残りは Accepted Risks)。
- AI 結果の保存期間・ユーザーによる削除(`docs/10` P1 未決。T-404 で扱う)、`ai_jobs` の定期削除。
- 構造化ログ・metric の実装(基盤未導入。必要な指標の定義のみ)。
- UI と Playwright E2E。

## Actors and Preconditions

| Actor                  | Preconditions                                                                 |
| ---------------------- | ----------------------------------------------------------------------------- |
| Guest(未認証)          | なし。`401`                                                                   |
| Member(email 確認済み) | T-101 の session。対象の週次レビュー(T-301)が自分のもので、`completed` である |
| Worker                 | queue message の `jobId` のみを入力に持つ。DB から job と入力を再構築する     |

actor の user ID は session のみから取得する。worker は job の `user_id` を actor として全 query に渡す。

## Functional Requirements

### AJOB-001 分析 job の依頼(冪等)

- `POST /api/v1/weekly-reviews/{reviewId}/analysis` は body なし(または `{}`)。対象レビューが自分のものでなければ `404 weekly_review_not_found`、`completed` でなければ `409 weekly_review_not_completed`。
- 週次レビューから `WeeklyImprovementInputV1` を組み立て(AJOB-002)、入力 fingerprint を求める。`(user, kind, subject, prompt_version, input_fingerprint)` が同じ job が既にあれば、新規作成せずその job を返す。
- 新規作成は `202`、既存は `200`(状態は問わない)。応答は `AiJob`(AJOB-005)。`Location: /api/v1/ai-jobs/{jobId}`。
- 新規 job は `queued` で保存したあと queue へ投入する。既存 job が `queued` なら、投入漏れの回復のため再投入する(重複投入は AJOB-003 の claim で無害)。queue への投入に失敗した場合は `503 queue_unavailable` を返し、job は `queued` のまま残す(再 `POST` で再投入できる)。
- active(`queued`/`running`)な job が同時に `AI_JOB_MAX_ACTIVE_PER_USER`(3)件ある場合、新規作成は `429 ai_job_limit_reached`(既存 job を返す場合は対象外)。

### AJOB-002 入力の最小化

- `WeeklyImprovementInputV1` は週次レビューの `summary` と `reflection`、および active 習慣の `cue`/`minimumAction` から組み立てる。含めるのは `subjectId`(job の外部 ID。review の ID ではない)、`weekStart`、習慣ごとの `kind`/`name`/`cue`/`minimumAction`/件数、`checkIn` の集計、`reflection` のみ。email、user ID、habit/review の外部 ID、チェックインのメモ、習慣の `purpose` は含めない。
- 習慣は summary の順に最大 `WEEKLY_INPUT_MAX_HABITS`(10)件。summary にあるがアーカイブ済みの習慣は `cue`/`minimumAction` を `null` として含める。
- 組み立てた入力は `weeklyImprovementInputV1Schema` で検証し、不適合(上限超過など)は job を作らず `422 analysis_input_invalid`(作成時)、worker では `failed`(`invalid_input`)。
- fingerprint は `subjectId` を除いた入力の canonical JSON(キーを辞書順に整列)の SHA-256(hex)。同じレビュー・同じ入力・同じ prompt version なら同じ値になる。

### AJOB-003 job の実行(claim と冪等)

- worker は message の `jobId` から job を claim する。claim は単一の `UPDATE` で、`queued` の job、または `running` で lease(`AI_JOB_LEASE_SECONDS` = 300 秒)を過ぎた job だけを `running` にできる。
- claim できない場合: job が存在しない・終端状態(`succeeded`/`fallback`/`failed`)→ 何もせず成功(ack)。`running` で lease 内 → 再配送のため失敗扱い(`batchItemFailures`)。
- claim 後に入力を再構築し(AJOB-002)、`generateSafeCoaching`(T-302)を呼ぶ。結果の `source` が `ai` なら `succeeded`、`fallback` なら `fallback` で、結果(AJOB-006)を保存する。
- 確定は `WHERE status = 'running'` 付きの単一 `UPDATE` と `ai_job_attempts` への記録を同一 transaction で行う。lease を奪われていて更新できなければ、何も書かず ack する(後続の実行者が確定する)。
- 実行ごとに `ai_job_attempts` を 1 行記録する(`attempt_no` は 1 から連番、`outcome`、`latency_ms`、`error_category`)。prompt・入力・出力本文は記録しない。

### AJOB-004 失敗・再配送・DLQ

- provider の一時的障害は `generateSafeCoaching` 内で最大 3 attempt、exponential backoff + full jitter(T-302)。それでも失敗した場合は `fallback`(`provider_unavailable`)で job を確定する(queue の再配送には載せない)。
- worker 自体の予期しない失敗(DB 障害など)は job を `queued` に戻して `batchItemFailures` に入れる(SQS が再配送する)。`ApproximateReceiveCount` が `AI_JOB_MAX_RECEIVE`(3)以上の失敗では、規則ベースの定型 fallback(`worker_exhausted`)で job を `fallback` に確定して ack する(ユーザーが永久に pending にならない)。確定自体に失敗した場合は `batchItemFailures` に入れ、DLQ に移る。
- 解釈できない message(JSON でない、schema 不適合)は再試行しても直らないため `batchItemFailures` に入れ、queue の redrive で DLQ に移す。
- job の入力元(レビュー)が消えた・`completed` でない場合は `failed`(`subject_unavailable`)で確定する。
- 終端状態の job は二度と変更しない。

### AJOB-005 job の取得

- `GET /api/v1/ai-jobs/{jobId}` は自分の job を `200` で返す。存在しない・他人の job・UUID 形式でない ID は区別せず `404 ai_job_not_found`。
- 応答 `AiJob`: `{ id, kind, status, subject: { type, id }, promptVersion, outputSchemaVersion, result, failureCode, createdAt, updatedAt }`。`result` は `succeeded`/`fallback` のとき AJOB-006、それ以外は `null`。`failureCode` は `failed` のとき。provider 名・model 名・fingerprint・内部 ID は返さない。

### AJOB-006 結果(`result_json`)

- 形: `{ schemaVersion: 1, source: "ai" | "fallback", output: WeeklyImprovementPlanV1, contentSafety: { status, reasonCodes }, fallbackReason: string | null }`。`fallbackReason` は T-302 の `FallbackReason` に `worker_exhausted` を加えたもの。
- `output` は T-302 の validator を通過した本文、または versioned の定型 fallback のみ。生の model 応答・prompt・入力は保存しない。
- 読み出し時は契約 schema で検証し、不適合は内部エラー(500)。

## Business Rules and Invariants

- AJOB-INV-001(所有者限定): すべての repository 操作は user ID を条件に含む(API は actor、worker は job の `user_id`)。他人の job・レビューには到達できない。
- AJOB-INV-002(冪等な作成): `(user_id, kind, subject_public_id, prompt_version, input_fingerprint)` は DB の unique 制約で 1 件。作成は `INSERT ... ON CONFLICT DO NOTHING` の単一文。
- AJOB-INV-003(単一実行): 同じ job を同時に実行できるのは claim に成功した 1 worker のみ(`UPDATE ... WHERE status = 'queued' OR (running AND lease 切れ)`)。lease の判定は DB の時刻を使う。
- AJOB-INV-004(終端不変): `succeeded`/`fallback`/`failed` の job の status・result は変更しない。状態遷移は `queued → running → (succeeded|fallback|failed)` と、worker 失敗時の `running → queued` のみ。
- AJOB-INV-005(整合): `succeeded`/`fallback` ⇔ `result_json IS NOT NULL`、`failed` ⇒ `failure_code IS NOT NULL`(DB CHECK でも強制)。
- AJOB-INV-006(最小化): queue message は `{ v, jobId }` のみ。入力は worker が DB から再構築する。provider に送る入力は AJOB-002 の項目に限る。
- AJOB-INV-007(AI の位置づけ): AI は提案を生成するだけで、習慣や設定を変更しない。結果は必ず `generateSafeCoaching` を経由する。
- AJOB-INV-008(公開 flag): `AI_PUBLICATION_ENABLED=false` の間、provider を呼ばず fallback(`disabled`)で job を確定する。

## State Transitions

| From      | Event                           | To          | 備考                                  |
| --------- | ------------------------------- | ----------- | ------------------------------------- |
| (なし)    | POST analysis                   | `queued`    | 冪等。既存 job は変更しない           |
| `queued`  | claim                           | `running`   | lease 開始                            |
| `running` | lease 切れ後の claim            | `running`   | 別 worker が引き継ぐ                  |
| `running` | `source: ai`                    | `succeeded` | attempt 記録                          |
| `running` | `source: fallback`              | `fallback`  | `fallbackReason` を保存               |
| `running` | 入力元がない/不正               | `failed`    | `subject_unavailable`/`invalid_input` |
| `running` | 予期しない失敗(受信回数 < 上限) | `queued`    | message は再配送                      |
| `running` | 予期しない失敗(受信回数 ≧ 上限) | `fallback`  | `worker_exhausted`                    |
| 終端状態  | 任意                            | (変更なし)  | ack のみ                              |

## Acceptance Criteria

```gherkin
Scenario: 確定済みレビューの分析を依頼して完了する
  Given completed の週次レビュー、AI_PUBLICATION_ENABLED=true、fake provider
  When POST /weekly-reviews/{id}/analysis を呼ぶ
  Then 202 で status は queued、Location が返る
  When worker が message を処理する
  Then GET /ai-jobs/{id} は status=succeeded、result.source="ai"、result.output が WeeklyImprovementPlanV1 を満たす

Scenario: 同じ依頼は同じ job を返す
  Given 同じレビューに対する分析 job が既にある
  When もう一度 POST する(並行 6 件を含む)
  Then job は 1 件で、2 件目以降は 200 で同じ id を返す

Scenario: 確定していないレビューは依頼できない
  Given draft のレビュー
  When POST analysis
  Then 409 weekly_review_not_completed で job は作られない

Scenario: 他人のレビュー・job
  Given ユーザー A のレビューと job
  When ユーザー B が POST analysis または GET /ai-jobs/{id}
  Then どちらも 404

Scenario: 重複配送
  Given 同じ jobId の message が 2 回届く
  When worker が両方を処理する
  Then provider は 1 回だけ呼ばれ、job は 1 回だけ確定する

Scenario: batch の部分失敗
  Given 3 件の record のうち 1 件が不正な body、1 件が一時的な DB 失敗
  When handler が処理する
  Then batchItemFailures は失敗した 2 件の messageId のみ

Scenario: provider が一時的に失敗し続ける
  Given fake provider が 429 を返し続ける
  When worker が処理する
  Then 3 attempt のあと job は fallback(provider_unavailable)で確定し、message は ack される

Scenario: worker が受信上限まで失敗する
  Given 確定処理が毎回例外になる、ApproximateReceiveCount=3
  When worker が処理する
  Then job は fallback(worker_exhausted)で確定し、batchItemFailures は空

Scenario: 公開 flag が無効
  Given AI_PUBLICATION_ENABLED=false
  When worker が処理する
  Then provider は呼ばれず、job は fallback(disabled)で確定する

Scenario: 同時実行中 job の上限
  Given 自分の active job が 3 件
  When 別のレビューで新規に POST analysis
  Then 429 ai_job_limit_reached(既存 job の再取得は 200)

Scenario: lease 切れの引き継ぎ
  Given running のまま lease を過ぎた job
  When 別 worker が処理する
  Then 引き継いで確定する。lease 内の running job は処理せず再配送に回す

Scenario: queue 投入の失敗
  Given queue が利用できない
  When POST analysis
  Then 503 queue_unavailable、job は queued で残り、再 POST で再投入される
```

## Authorization Matrix

| Operation                          | Guest | Member(自分の) | Member(他人の) | Worker                |
| ---------------------------------- | ----: | -------------: | -------------: | --------------------- |
| POST /weekly-reviews/{id}/analysis |   401 |            Yes |            404 | -                     |
| GET /ai-jobs/{id}                  |   401 |            Yes |            404 | -                     |
| claim/確定(queue message 経由)     |     - |              - |              - | job の `user_id` のみ |

IDOR/BOLA: `reviewId`/`jobId` は外部公開 ID(UUID)で、repository が `public_id` と `user_id` の両方で解決する。Admin は対象外(T-403)。

## API and Events

共通: base path `/api/v1`、JSON、Problem Details、`Cache-Control: no-store`。`POST` は Origin 検証(CSRF)。

| Method/Path                                | 入力                 | 成功    | エラー                                      |
| ------------------------------------------ | -------------------- | ------- | ------------------------------------------- |
| `POST /weekly-reviews/{reviewId}/analysis` | path(body なし/`{}`) | 202/200 | 401, 403, 404, 409, 413, 415, 422, 429, 503 |
| `GET /ai-jobs/{jobId}`                     | path                 | 200     | 401, 404                                    |

エラー code: `weekly_review_not_found`(404)、`weekly_review_not_completed`(409)、`analysis_input_invalid`(422)、`ai_job_limit_reached`(429)、`queue_unavailable`(503)、`ai_job_not_found`(404)。

### Queue message(`ai-coaching` queue)

```json
{ "v": 1, "jobId": "<uuid>" }
```

- 入力・自由記述・user ID を含めない。at-least-once 配送を前提に、worker は冪等(AJOB-003)。
- SQS event の `Records[].messageId`/`body`/`attributes.ApproximateReceiveCount` を使う。戻り値は `{ batchItemFailures: [{ itemIdentifier: messageId }] }`(ReportBatchItemFailures)。

### Resource: AiJob

```json
{
  "id": "<uuid>",
  "kind": "weekly_improvement",
  "status": "succeeded",
  "subject": { "type": "weekly_review", "id": "<uuid>" },
  "promptVersion": "weekly-improvement/1",
  "outputSchemaVersion": "1",
  "result": {
    "schemaVersion": 1,
    "source": "ai",
    "output": { "...": "WeeklyImprovementPlanV1" },
    "contentSafety": {
      "status": "pass",
      "reasonCodes": [],
      "validatorVersion": "<version>",
      "fallbackVersion": null
    },
    "fallbackReason": null
  },
  "failureCode": null,
  "createdAt": "2026-01-14T00:00:00.000Z",
  "updatedAt": "2026-01-14T00:00:05.000Z"
}
```

## Data and Migration

- 既存の `ai_jobs`/`ai_job_attempts`(`public_id` UNIQUE、`ai_jobs_status_check`、`ai_job_attempts` の `UNIQUE(ai_job_id, attempt_no)`、`ON DELETE CASCADE`、`set_updated_at` trigger)を使う。
- Migration(expand、後方互換。`ai_jobs` は T-303 以前にアプリが書き込んでおらず既存行がない前提のため backfill 不要。適用前に件数 0 を確認する):
  - unique index `ai_jobs_idempotency_uidx (user_id, kind, subject_public_id, prompt_version, input_fingerprint)`(冪等な作成の arbiter)。
  - `ai_jobs_kind_check`: `kind IN ('weekly_improvement', 'habit_design')`。
  - `ai_jobs_result_check`: `(status IN ('succeeded','fallback')) = (result_json IS NOT NULL)` かつ `result_json` は object。
  - `ai_jobs_failure_code_check`: `status <> 'failed' OR failure_code IS NOT NULL`。
  - `ai_job_attempts_check`: `attempt_no >= 1`、`outcome IN ('succeeded','fallback','failed','error')`、`latency_ms IS NULL OR latency_ms >= 0`。
- アクセスパターン: 取得は `public_id`(UNIQUE) + `user_id`。active 件数は `user_id`(既存 `ai_jobs_user_id_idx`)で絞って `status` を数える。FK `ai_job_attempts.ai_job_id` は `(ai_job_id, attempt_no)` の unique が index を兼ねる。
- rollback: 制約と index を drop する forward migration、またはアプリの revert。データ損失なし(結果は再生成できる)。

## Failure and Edge Cases

- 週次レビューが分析中に消えた/アカウントが削除された → job は FK cascade で消える。worker が job を見つけられなければ ack。
- 同じ message が lease 内に別 worker へ配送された → 再配送へ(二重実行しない)。worker が lease より長くかかった → 別 worker が引き継ぎ、先の worker の確定は `WHERE status = 'running'` と attempt の unique で無効になる(結果は 1 つ)。
- 習慣が編集された後の再依頼 → 入力が変われば fingerprint が変わり別 job になる。同じなら既存 job。
- prompt version が更新された後の再依頼 → 別 job。
- provider の model 名: 実行前は設定値、確定時に実際の値で更新する。
- 保存済み `result_json` が schema に合わない → 500(内部詳細を含めない)。
- fake provider のまま本番で公開を有効にすることは Config が拒否する。

## Security and Privacy

- Data collected: 分析結果(提案文)を `ai_jobs.result_json` に保存する。入力は保存しない(fingerprint のみ)。provider へ送るのは AJOB-002 の最小化した入力のみで、本タスクでは fake provider のため外部送信は発生しない。実 provider 追加時は ADR-003 と `docs/08` のデータ保護節に従う。
- Data forbidden in logs: 入力、`reflection`、生成本文、queue message の本文(`jobId` 以外)、email、session。worker は処理結果の件数と status のみを扱う。
- IDOR/BOLA: AJOB-INV-001。CSRF: POST は Origin 検証。Injection: Prisma の型付き query と `$queryRaw` のタグ付きテンプレートのみ。XSS: JSON のみ。
- Prompt injection: ユーザーの自由記述(`reflection`)は T-302 の事前検査・validator を通る。AI の出力は提案であり、習慣・設定を変更する tool は公開しない(AJOB-INV-007)。
- Abuse: 同時実行中 job は 1 ユーザー 3 件まで。同一入力は 1 job に収束する。rate limit・コスト上限は Accepted Risks。
- queue message は `jobId` のみで、漏えいしても内容に到達できない(DB 参照は user 条件付き)。

## AI Requirements

- 唯一の入口は `generateSafeCoaching`(T-302)。`purpose: "weekly_improvement"`、prompt version `weekly-improvement/1`、output schema `WeeklyImprovementPlanV1`(version `1`)、provider は `fake`(model `fake-model-1`)を version として `ai_jobs` に保存する。
- timeout・retry・fallback・第三者コンテンツ検査・再生成上限は T-302 の仕様を継承する(1 attempt あたりの timeout は設定値)。worker 失敗時の `worker_exhausted` fallback は T-302 の `buildWeeklyImprovementFallback` を使う。
- Eval: 本タスクは基盤であり、分析内容の品質 eval は T-305。T-303 では「pipeline が schema 不適合・refusal・安全性拒否・timeout を fallback にする」ことを Unit/Integration で検証する。
- AI の公開 feature flag(`AI_PUBLICATION_ENABLED`、既定 false)で provider 呼び出しを停止できる(T-302 の代替手段。false の間も job は `fallback`(`disabled`)で完結する)。

## Observability and Operations

- Logs: 業務ロジックに独自ログを追加しない(構造化ログ基盤が未導入)。監査(`AiAuditSinkPort`)は本文を持たないイベントのみで、本タスクでは no-op の sink を配線する。実 sink は T-501 の observability と合わせる。
- Metrics/Alerts(T-501 で実装する要件。`docs/06` と同じ): queue depth と oldest message age、DLQ > 0、Lambda error/throttle、job の status 別件数、fallback 率(`fallbackReason` 別)、attempt の latency。`worker_exhausted` の急増をアラート対象にする。
- 配備設定の要件(T-501): SQS visibility timeout は Lambda timeout の 6 倍以上かつ `AI_JOB_LEASE_SECONDS`(300 秒)以下、`maxReceiveCount` は `AI_JOB_MAX_RECEIVE`(3)と一致、ReportBatchItemFailures 有効、Lambda reserved concurrency で DB 接続と provider を保護、暗号化(KMS)と DLQ の retention。
- Runbook: DLQ の message は解釈不能な message のみ(job は worker が fallback で確定済みのため)。DLQ の確認と redrive の手順は T-501 の Runbook に含める。
- Rollout: `AI_PUBLICATION_ENABLED=false` で配備し、段階的に有効化する。rollback は flag の停止(API は fallback を返し続ける)とアプリの revert。

## Test Coverage Matrix

| Requirement      | Unit                                                                                                                                                                  | Integration(実 PostgreSQL)                                                     | E2E                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| AJOB-001         | `requestWeeklyAnalysisUseCase`(新規 202 相当/既存 200 相当、draft は拒否、他人は not found、上限、再投入、queue 失敗)、handler の 202/200/401/403/404/409/422/429/503 | 作成の往復、同一入力は 1 job、並行 6 件で 1 行、active 上限                    | N/A(E2E 基盤の分析フローは UI 後) |
| AJOB-002         | `buildWeeklyImprovementInput`(最小化、10 件上限、アーカイブ済み習慣、スキーマ適合)、fingerprint(キー順不問・subjectId 非依存・値が変わると変わる)                     | 実 DB のレビュー・習慣から組み立てた入力                                       | N/A                               |
| AJOB-003         | `processAiJobUseCase`(正常、重複配送で provider 1 回、claim 失敗の分岐、lease 内/切れ、確定の競合)                                                                    | claim の原子性(並行 6 件で 1 つだけ成功)、lease 切れの引き継ぎ、attempt の記録 | N/A                               |
| AJOB-004         | provider 失敗→fallback、flag 無効、予期しない失敗の再キュー、受信上限での `worker_exhausted`、subject 消失で failed、`handleAiJobMessages` の部分失敗・不正 message   | -                                                                              | N/A                               |
| AJOB-005/006     | `getAiJobUseCase`、handler(内部情報を含まない)、result schema                                                                                                         | 他ユーザーの job は not found、`result_json` の往復                            | N/A                               |
| AJOB-INV-004/005 | 終端状態は変更されない                                                                                                                                                | CHECK 制約(status と result_json、failed と failure_code)、確定の競合          | N/A                               |
| パイプライン     | in-memory queue + worker handler で queued→succeeded                                                                                                                  | inline queue + 実 DB + fake provider で POST→処理→GET が succeeded             | N/A                               |
| Migration        | -                                                                                                                                                                     | fresh DB と既存 schema(直前 migration まで)からの upgrade の両方               | N/A                               |
| 契約             | queue message schema(未知キー、型)、job/result schema                                                                                                                 | -                                                                              | N/A                               |
| Config           | `AI_QUEUE_DRIVER`/`AI_PROVIDER` の本番拒否、既定値                                                                                                                    | -                                                                              | N/A                               |

テスト品質の 3 観点: 状態遷移・fingerprint・batch 処理の不変条件はシード固定の性質テスト、実装を意図的に壊す変異確認(手動。Stryker 未導入)、敵対的審査(重複配送、並行 claim、不正 message、他人の ID、lease 境界、改ざん)を実施し、結果を完了報告に記す。

Fake/Stub 方針: Application の unit test は in-memory の job repository/queue、固定 Clock、T-302 の fake provider(`createFakeAiCoach`)。Integration は Testcontainers の実 PostgreSQL。fixture は架空データのみ。

## Open Questions

実装をブロックしない事項:

- **実 SQS adapter・Terraform・Lambda 配備**: T-501。本 Spec の port と message 契約・設定要件に従う。
- **AI 結果の保存期間・ユーザー削除**(`docs/10` P1): 未決のまま `ai_jobs` を保持する。決定後に別 Spec で扱う。
- **実 provider の選定とコスト上限**(ADR-003): fake のみで進める。
- **分析 job を確定前のレビューに許可するか**: 本 Spec は `completed` のみ。必要になれば T-305 で見直す。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-10-09
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                             |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope。`docs/09` T-303、`docs/05` の API 一覧                                                    |
| Specification        | Pass   | AJOB-001〜006、AJOB-INV-001〜008、State Transitions、Acceptance Criteria、Failure and Edge Cases。未決事項は非ブロック(D-16 で決定)  |
| Domain and Time      | Pass   | 状態遷移と lease(DB 時刻で判定)、Clock 注入、at-least-once と冪等性、競合・lease 切れ・重複配送を明記                                |
| API and Data         | Pass   | API and Events(202/200、エラー code、message 契約)、Data and Migration(expand、unique/CHECK、index、rollback)                        |
| Security and Privacy | Pass   | Security and Privacy、Authorization Matrix(IDOR/CSRF/prompt injection/abuse、message の最小化、ログ禁止)                             |
| AI                   | Pass   | AI Requirements(`generateSafeCoaching` 経由、versioning、fallback、flag、eval の範囲)。実 provider は ADR-003 のとおり本タスク対象外 |
| Testing              | Pass   | Test Coverage Matrix(timeout/429/5xx/部分 batch/重複)。E2E は UI 未実装のため N/A と理由を明記                                       |
| Operations           | Pass   | Observability and Operations(配備設定の要件、alarm、DLQ の扱い、flag による rollout/rollback)。実配備は T-501 と明記                 |
| Planning             | Pass   | [../plans/ai-queue-pipeline.md](../plans/ai-queue-pipeline.md)                                                                       |

### Accepted Risks

- 実 SQS adapter 未実装のため、本タスク単体では本番に配備できない(config が本番での `inline` と、fake のままの公開有効化を拒否する)。T-501 で adapter と infra を追加する。
- Rate limit・ユーザー別コスト上限・circuit breaker は未実装。同時実行中 job の上限(3)と同一入力の冪等化のみで抑える。
- inline queue(ローカル/E2E 用)は同一プロセスの非同期実行で、プロセス終了時に未処理 job が `queued` のまま残る(再 `POST` で再投入できる)。
- 入力の fingerprint は SHA-256 で、衝突は無視できるとみなす。
- 構造化ログ未導入のため、worker 固有の運用ログ/metric は追加しない(監査は no-op sink)。
