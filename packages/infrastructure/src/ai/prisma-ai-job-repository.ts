import type {
  AiJobAttemptRecord,
  AiJobKind,
  AiJobRecord,
  AiJobRepositoryPort,
  ClaimAiJobResult,
} from "@habit-app/application";
import { isAiJobStatus, isTerminalAiJobStatus } from "@habit-app/domain";
import type { Prisma } from "../generated/prisma/client";
import type { PrismaClient } from "../generated/prisma/client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** actor の user ID(session 由来の十進文字列)を bigint へ。形式不正は「何にも到達できない」扱い。 */
function parseUserId(actorUserId: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(actorUserId)) return null;
  const value = BigInt(actorUserId);
  return value <= MAX_BIGINT ? value : null;
}

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(): Error {
  return new Error("persisted ai job violates invariants");
}

function toKind(value: string): AiJobKind {
  if (value !== "weekly_improvement" && value !== "habit_design") throw corrupted();
  return value;
}

interface JobRow {
  public_id: string;
  user_id: string;
  kind: string;
  subject_type: string;
  subject_public_id: string;
  status: string;
  prompt_version: string;
  output_schema_version: string;
  provider: string;
  model: string;
  result_json: unknown;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

function fromRow(row: JobRow): AiJobRecord {
  if (!isAiJobStatus(row.status)) throw corrupted();
  return {
    id: row.public_id,
    userId: row.user_id,
    kind: toKind(row.kind),
    subjectType: row.subject_type,
    subjectId: row.subject_public_id,
    status: row.status,
    promptVersion: row.prompt_version,
    outputSchemaVersion: row.output_schema_version,
    provider: row.provider,
    model: row.model,
    result: row.result_json ?? null,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromModel(row: {
  publicId: string;
  userId: bigint;
  kind: string;
  subjectType: string;
  subjectPublicId: string;
  status: string;
  promptVersion: string;
  outputSchemaVersion: string;
  provider: string;
  model: string;
  resultJson: unknown;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AiJobRecord {
  return fromRow({
    public_id: row.publicId,
    user_id: row.userId.toString(),
    kind: row.kind,
    subject_type: row.subjectType,
    subject_public_id: row.subjectPublicId,
    status: row.status,
    prompt_version: row.promptVersion,
    output_schema_version: row.outputSchemaVersion,
    provider: row.provider,
    model: row.model,
    result_json: row.resultJson,
    failure_code: row.failureCode,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

/** attempt を `ai_job_attempts` へ記録する(attempt_no は job ごとの連番)。呼び出し元の transaction 内で使う。 */
async function insertAttempt(
  tx: Prisma.TransactionClient,
  aiJobId: bigint,
  attempt: AiJobAttemptRecord,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO ai_job_attempts
      (ai_job_id, attempt_no, started_at, finished_at, outcome, latency_ms, error_category)
    SELECT ${aiJobId}, COALESCE(MAX(attempt_no), 0) + 1, ${attempt.startedAt}, ${attempt.finishedAt},
           ${attempt.outcome}, ${attempt.latencyMs}, ${attempt.errorCategory}
    FROM ai_job_attempts
    WHERE ai_job_id = ${aiJobId}`;
}

/**
 * AiJobRepositoryPort の Prisma 実装(docs/plans/ai-queue-pipeline.md)。
 *
 * - API 向けの query は `user_id = actor` を条件に含み、外部 ID(`public_id`)でのみ解決する(AJOB-INV-001)。
 * - 作成は `INSERT ... ON CONFLICT (冪等キー) DO NOTHING` の単一文(AJOB-INV-002)。
 * - claim は単一の `UPDATE` で、`queued` または lease を過ぎた `running` だけを `running` にする
 *   (AJOB-INV-003)。lease の判定は DB の時刻(`updated_at` は `set_updated_at` trigger が更新時に設定)。
 * - 確定・解放は `WHERE status = 'running'` 付きの `UPDATE` と attempt の記録を同一 transaction で行い、
 *   終端状態を上書きしない(AJOB-INV-004)。
 * - raw SQL は `$queryRaw`/`$executeRaw` のタグ付きテンプレート(バインド変数のみ)で、文字列連結をしない。
 * - 入力・prompt・生成本文は `result_json`(検証済みの構造化出力)以外に保存しない。
 */
export function createPrismaAiJobRepository(prisma: PrismaClient): AiJobRepositoryPort {
  return {
    async findByInput({ actorUserId, kind, subjectId, promptVersion, inputFingerprint }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !UUID_PATTERN.test(subjectId)) return null;
      const row = await prisma.aiJob.findFirst({
        where: {
          userId,
          kind,
          subjectPublicId: subjectId,
          promptVersion,
          inputFingerprint,
        },
      });
      return row === null ? null : fromModel(row);
    },

    async countActive({ actorUserId }) {
      const userId = parseUserId(actorUserId);
      if (userId === null) return 0;
      return prisma.aiJob.count({ where: { userId, status: { in: ["queued", "running"] } } });
    },

    async createOrGet(input) {
      const userId = parseUserId(input.actorUserId);
      if (userId === null || !UUID_PATTERN.test(input.subjectId)) return null;

      const inserted = await prisma.$queryRaw<JobRow[]>`
        INSERT INTO ai_jobs
          (user_id, kind, subject_type, subject_public_id, status, prompt_version,
           output_schema_version, provider, model, input_fingerprint, created_at, updated_at)
        SELECT u.id, ${input.kind}, ${input.subjectType}, ${input.subjectId}::uuid, 'queued',
               ${input.promptVersion}, ${input.outputSchemaVersion}, ${input.provider},
               ${input.model}, ${input.inputFingerprint}, ${input.now}, ${input.now}
        FROM users u
        WHERE u.id = ${userId}
        ON CONFLICT (user_id, kind, subject_public_id, prompt_version, input_fingerprint) DO NOTHING
        RETURNING public_id::text AS public_id, user_id::text AS user_id, kind, subject_type,
          subject_public_id::text AS subject_public_id, status, prompt_version,
          output_schema_version, provider, model, result_json, failure_code, created_at, updated_at`;
      const created = inserted[0];
      if (created !== undefined) return { job: fromRow(created), created: true };

      // 0 行: 既に同じ冪等キーの job がある(並行作成の敗者を含む)か、actor の user が存在しない。
      const existing = await prisma.aiJob.findFirst({
        where: {
          userId,
          kind: input.kind,
          subjectPublicId: input.subjectId,
          promptVersion: input.promptVersion,
          inputFingerprint: input.inputFingerprint,
        },
      });
      if (existing !== null) return { job: fromModel(existing), created: false };
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (user === null) return null;
      // user はいるのに挿入も既存取得もできない(直後に削除された等)。内部エラーとして扱う。
      throw new Error("ai job could not be created or found");
    },

    async findById({ actorUserId, jobId }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !UUID_PATTERN.test(jobId)) return null;
      const row = await prisma.aiJob.findFirst({ where: { userId, publicId: jobId } });
      return row === null ? null : fromModel(row);
    },

    async claim({ jobId, leaseSeconds }): Promise<ClaimAiJobResult> {
      if (!UUID_PATTERN.test(jobId)) return { status: "not_found" };

      const claimed = await prisma.$queryRaw<JobRow[]>`
        UPDATE ai_jobs
        SET status = 'running'
        WHERE public_id = ${jobId}::uuid
          AND (status = 'queued'
               OR (status = 'running'
                   AND updated_at < now() - make_interval(secs => ${leaseSeconds}::double precision)))
        RETURNING public_id::text AS public_id, user_id::text AS user_id, kind, subject_type,
          subject_public_id::text AS subject_public_id, status, prompt_version,
          output_schema_version, provider, model, result_json, failure_code, created_at, updated_at`;
      const row = claimed[0];
      if (row !== undefined) return { status: "claimed", job: fromRow(row) };

      // 0 行: 存在しない・終端状態・lease 内の running のいずれか。
      const current = await prisma.aiJob.findFirst({
        where: { publicId: jobId },
        select: { status: true },
      });
      if (current === null) return { status: "not_found" };
      if (!isAiJobStatus(current.status)) throw corrupted();
      return isTerminalAiJobStatus(current.status)
        ? { status: "finished" }
        : { status: "in_progress" };
    },

    async complete(input) {
      if (!UUID_PATTERN.test(input.jobId)) return "lost";
      const resultJson = input.status === "failed" ? null : JSON.stringify(input.result);
      const model = input.status === "failed" ? null : input.model;
      const failureCode = input.status === "failed" ? input.failureCode : null;

      return prisma.$transaction(async (tx) => {
        const updated = await tx.$queryRaw<{ id: bigint }[]>`
          UPDATE ai_jobs
          SET status = ${input.status},
              model = COALESCE(${model}::text, model),
              result_json = ${resultJson}::jsonb,
              failure_code = ${failureCode}::text
          WHERE public_id = ${input.jobId}::uuid AND status = 'running'
          RETURNING id`;
        const row = updated[0];
        if (row === undefined) return "lost" as const;
        await insertAttempt(tx, row.id, input.attempt);
        return "completed" as const;
      });
    },

    async release({ jobId, attempt }) {
      if (!UUID_PATTERN.test(jobId)) return;
      await prisma.$transaction(async (tx) => {
        const updated = await tx.$queryRaw<{ id: bigint }[]>`
          UPDATE ai_jobs
          SET status = 'queued'
          WHERE public_id = ${jobId}::uuid AND status = 'running'
          RETURNING id`;
        const row = updated[0];
        if (row === undefined) return;
        await insertAttempt(tx, row.id, attempt);
      });
    },
  };
}
