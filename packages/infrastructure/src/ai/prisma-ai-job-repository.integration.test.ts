import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_JOB_MAX_ACTIVE_PER_USER,
  AiJobNotFoundError,
  WEEKLY_IMPROVEMENT_PROMPT_VERSION,
  WeeklyReviewNotCompletedError,
  createHabitUseCase,
  createWeeklyReviewUseCase,
  getAiJobUseCase,
  handleAiJobMessages,
  processAiJobUseCase,
  requestWeeklyAnalysisUseCase,
  updateWeeklyReviewUseCase,
} from "@habit-app/application";
import type { AiJobAttemptRecord, AiJobRepositoryPort } from "@habit-app/application";
import { aiJobResultV1Schema } from "@habit-app/contracts";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../database/prisma-client";
import type { PrismaClient } from "../database/prisma-client";
import { createPrismaHabitRepository } from "../habits/prisma-habit-repository";
import { createUuidGenerator } from "../habits/uuid-generator";
import { createPrismaProfileRepository } from "../identity/prisma-profile-repository";
import { createPrismaDailyCheckInRepository } from "../tracking/prisma-daily-check-in-repository";
import { createPrismaHabitEntryRepository } from "../tracking/prisma-habit-entry-repository";
import { createPrismaWeeklyReviewRepository } from "../tracking/prisma-weekly-review-repository";
import { createFakeAiCoach } from "./fake-ai-coach";
import type { FakeAiCoachStep } from "./fake-ai-coach";
import { createInlineAiJobQueue } from "./inline-ai-job-queue";
import { createNoopAiAuditSink } from "./noop-ai-audit-sink";
import { createPrismaAiJobRepository } from "./prisma-ai-job-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");
const T303_MIGRATION = "20261009000000_t303_ai_job_constraints";

// 2026-01-14(水)12:00 JST。週(月曜始まり)は 2026-01-05(月)〜2026-01-11(日)。
const NOW = new Date("2026-01-14T03:00:00.000Z");
const WEEK = "2026-01-05";
const clock = () => NOW;
const SUBJECT = "30000000-0000-4000-8000-000000000001";

function migrateDeploy(connectionUri: string): void {
  execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
    cwd: infrastructureRoot,
    env: { ...process.env, DATABASE_URL: connectionUri },
    stdio: "pipe",
  });
}

const attempt = (outcome: AiJobAttemptRecord["outcome"]): AiJobAttemptRecord => ({
  outcome,
  startedAt: NOW,
  finishedAt: new Date(NOW.getTime() + 25),
  latencyMs: 25,
  errorCategory: outcome === "error" ? "worker_error" : null,
});

describe("PrismaAiJobRepository(T-303)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let sequence = 0;
  let subjectSequence = 0;

  const repository = (): AiJobRepositoryPort => createPrismaAiJobRepository(prisma);

  async function createUser(): Promise<string> {
    sequence += 1;
    const label = `ai-job-user-${sequence}`;
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}@example.com`,
        emailNormalized: `${label}@example.com`,
        passwordHash: "hash",
      },
    });
    return user.id.toString();
  }

  /** 別々の subject / fingerprint の job を作る。 */
  async function newJob(
    actorUserId: string,
    overrides: { subjectId?: string; fingerprint?: string } = {},
  ) {
    subjectSequence += 1;
    const subjectId =
      overrides.subjectId ?? `30000000-0000-4000-8000-${String(subjectSequence).padStart(12, "0")}`;
    const saved = await repository().createOrGet({
      actorUserId,
      kind: "weekly_improvement",
      subjectType: "weekly_review",
      subjectId,
      promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
      outputSchemaVersion: "1",
      provider: "fake",
      model: "fake-model-1",
      inputFingerprint: overrides.fingerprint ?? "f".repeat(64),
      now: NOW,
    });
    if (saved === null) throw new Error("user missing");
    return saved;
  }

  const attemptRows = (jobId: string) =>
    prisma.aiJobAttempt.findMany({
      where: { aiJob: { publicId: jobId } },
      orderBy: { attemptNo: "asc" },
    });

  beforeAll(async () => {
    container = await startPostgresContainer();
    migrateDeploy(container.getConnectionUri());
    prisma = createPrismaClient(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  describe("作成(AJOB-INV-002)", () => {
    it("queued で作成でき、取得できる。内部 ID を持たない", async () => {
      const userId = await createUser();
      const { job, created } = await newJob(userId);

      expect(created).toBe(true);
      expect(job).toMatchObject({
        userId,
        kind: "weekly_improvement",
        subjectType: "weekly_review",
        status: "queued",
        promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
        provider: "fake",
        model: "fake-model-1",
        result: null,
        failureCode: null,
      });
      expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(job.createdAt).toEqual(NOW);
      expect(await repository().findById({ actorUserId: userId, jobId: job.id })).toEqual(job);
    });

    it("同じ冪等キーは既存を返し(created=false)、1 行のまま", async () => {
      const userId = await createUser();
      const first = await newJob(userId, { subjectId: SUBJECT });
      const second = await newJob(userId, { subjectId: SUBJECT });
      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
      expect(await prisma.aiJob.count({ where: { userId: BigInt(userId) } })).toBe(1);

      // fingerprint が違えば別 job
      const other = await newJob(userId, { subjectId: SUBJECT, fingerprint: "e".repeat(64) });
      expect(other.created).toBe(true);
    });

    it("並行して 6 件作成しても 1 行で、created は 1 件のみ", async () => {
      const userId = await createUser();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => newJob(userId, { subjectId: SUBJECT })),
      );
      expect(await prisma.aiJob.count({ where: { userId: BigInt(userId) } })).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    });

    it("同じ subject でも別ユーザーなら別 job。user が存在しなければ null", async () => {
      const userA = await createUser();
      const userB = await createUser();
      const a = await newJob(userA, { subjectId: SUBJECT });
      const b = await newJob(userB, { subjectId: SUBJECT });
      expect(a.job.id).not.toBe(b.job.id);

      const before = await prisma.aiJob.count();
      const missing = await repository().createOrGet({
        actorUserId: "999999",
        kind: "weekly_improvement",
        subjectType: "weekly_review",
        subjectId: SUBJECT,
        promptVersion: "p",
        outputSchemaVersion: "1",
        provider: "fake",
        model: "m",
        inputFingerprint: "x",
        now: NOW,
      });
      expect(missing).toBeNull();
      expect(await prisma.aiJob.count()).toBe(before);
    });

    it("findByInput / countActive / findById は actor で分離され、不正な ID は到達しない", async () => {
      const userA = await createUser();
      const userB = await createUser();
      const { job } = await newJob(userA, { subjectId: SUBJECT });
      const key = {
        kind: "weekly_improvement",
        subjectId: SUBJECT,
        promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
        inputFingerprint: "f".repeat(64),
      } as const;

      expect((await repository().findByInput({ actorUserId: userA, ...key }))?.id).toBe(job.id);
      expect(await repository().findByInput({ actorUserId: userB, ...key })).toBeNull();
      expect(await repository().countActive({ actorUserId: userA })).toBe(1);
      expect(await repository().countActive({ actorUserId: userB })).toBe(0);
      expect(await repository().findById({ actorUserId: userB, jobId: job.id })).toBeNull();
      for (const jobId of ["1", "abc", "'; DROP TABLE ai_jobs;--"]) {
        expect(await repository().findById({ actorUserId: userA, jobId })).toBeNull();
      }
      expect(await repository().countActive({ actorUserId: "abc" })).toBe(0);
    });
  });

  describe("countActive", () => {
    it("queued と running だけを数え、終端状態(succeeded/fallback/failed)は数えない", async () => {
      const userId = await createUser();
      const queued = await newJob(userId);
      const running = await newJob(userId);
      const failed = await newJob(userId);
      const finished = await newJob(userId);
      expect(queued.created && running.created && failed.created && finished.created).toBe(true);

      await repository().claim({ jobId: running.job.id, leaseSeconds: 300 });
      await repository().claim({ jobId: failed.job.id, leaseSeconds: 300 });
      await repository().complete({
        jobId: failed.job.id,
        status: "failed",
        failureCode: "invalid_input",
        attempt: attempt("failed"),
      });
      await repository().claim({ jobId: finished.job.id, leaseSeconds: 300 });
      await repository().complete({
        jobId: finished.job.id,
        status: "fallback",
        model: "m",
        result: {
          schemaVersion: 1,
          source: "fallback",
          output: { summary: "x" },
          contentSafety: {
            status: "fallback",
            reasonCodes: [],
            validatorVersion: "v1",
            fallbackVersion: "f1",
          },
          fallbackReason: "disabled",
        },
        attempt: attempt("fallback"),
      });

      // queued 1 件 + running 1 件のみ
      expect(await repository().countActive({ actorUserId: userId })).toBe(2);
    });
  });

  describe("claim(AJOB-INV-003)", () => {
    it("queued は claimed になり running へ。再度の claim は in_progress", async () => {
      const userId = await createUser();
      const { job } = await newJob(userId);

      const first = await repository().claim({ jobId: job.id, leaseSeconds: 300 });
      expect(first).toMatchObject({
        status: "claimed",
        job: { id: job.id, status: "running", userId },
      });
      expect(await repository().claim({ jobId: job.id, leaseSeconds: 300 })).toEqual({
        status: "in_progress",
      });
    });

    it("並行して 6 件 claim しても claimed は 1 件のみ", async () => {
      const userId = await createUser();
      const { job } = await newJob(userId);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => repository().claim({ jobId: job.id, leaseSeconds: 300 })),
      );
      expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
      expect(results.filter((result) => result.status === "in_progress")).toHaveLength(5);
    });

    it("lease を過ぎた running は引き継げ、lease 内(境界の手前)は引き継げない", async () => {
      const userId = await createUser();
      const { job } = await newJob(userId);
      await repository().claim({ jobId: job.id, leaseSeconds: 300 });

      // updated_at は trigger が管理するため、テストでは trigger を一時的に外して時刻を過去へ動かす。
      const setAge = async (seconds: number) => {
        await prisma.$executeRawUnsafe(`ALTER TABLE ai_jobs DISABLE TRIGGER set_updated_at`);
        await prisma.$executeRaw`UPDATE ai_jobs SET updated_at = now() - make_interval(secs => ${seconds}::double precision) WHERE public_id = ${job.id}::uuid`;
        await prisma.$executeRawUnsafe(`ALTER TABLE ai_jobs ENABLE TRIGGER set_updated_at`);
      };

      await setAge(290);
      expect((await repository().claim({ jobId: job.id, leaseSeconds: 300 })).status).toBe(
        "in_progress",
      );
      await setAge(310);
      expect((await repository().claim({ jobId: job.id, leaseSeconds: 300 })).status).toBe(
        "claimed",
      );
    });

    it("存在しない・不正な ID は not_found、終端状態は finished", async () => {
      const userId = await createUser();
      expect(
        await repository().claim({
          jobId: "30000000-0000-4000-8000-ffffffffffff",
          leaseSeconds: 300,
        }),
      ).toEqual({ status: "not_found" });
      expect(await repository().claim({ jobId: "not-a-uuid", leaseSeconds: 300 })).toEqual({
        status: "not_found",
      });

      const { job } = await newJob(userId);
      await repository().claim({ jobId: job.id, leaseSeconds: 300 });
      await repository().complete({
        jobId: job.id,
        status: "failed",
        failureCode: "invalid_input",
        attempt: attempt("failed"),
      });
      expect(await repository().claim({ jobId: job.id, leaseSeconds: 300 })).toEqual({
        status: "finished",
      });
    });
  });

  describe("complete / release(AJOB-INV-004/005)", () => {
    const result = {
      schemaVersion: 1,
      source: "ai",
      output: { summary: "x" },
      contentSafety: {
        status: "pass",
        reasonCodes: [],
        validatorVersion: "v1",
        fallbackVersion: null,
      },
      fallbackReason: null,
    };

    it("running を succeeded に確定し、結果・model・attempt(連番 1)を保存する", async () => {
      const userId = await createUser();
      const { job } = await newJob(userId);
      await repository().claim({ jobId: job.id, leaseSeconds: 300 });

      const done = await repository().complete({
        jobId: job.id,
        status: "succeeded",
        model: "real-model-9",
        result,
        attempt: attempt("succeeded"),
      });
      expect(done).toBe("completed");

      const stored = await repository().findById({ actorUserId: userId, jobId: job.id });
      expect(stored).toMatchObject({ status: "succeeded", model: "real-model-9", result });
      const rows = await attemptRows(job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        attemptNo: 1,
        outcome: "succeeded",
        latencyMs: 25,
        errorCategory: null,
      });
    });

    it("終端の job や queued の job は確定できず(lost)、何も書かない", async () => {
      const userId = await createUser();
      const { job } = await newJob(userId);
      // queued のまま
      expect(
        await repository().complete({
          jobId: job.id,
          status: "succeeded",
          model: "m",
          result,
          attempt: attempt("succeeded"),
        }),
      ).toBe("lost");
      expect(await attemptRows(job.id)).toHaveLength(0);

      await repository().claim({ jobId: job.id, leaseSeconds: 300 });
      await repository().complete({
        jobId: job.id,
        status: "failed",
        failureCode: "subject_unavailable",
        attempt: attempt("failed"),
      });
      expect(
        await repository().complete({
          jobId: job.id,
          status: "succeeded",
          model: "m",
          result,
          attempt: attempt("succeeded"),
        }),
      ).toBe("lost");
      const stored = await repository().findById({ actorUserId: userId, jobId: job.id });
      expect(stored).toMatchObject({
        status: "failed",
        failureCode: "subject_unavailable",
        result: null,
      });
      expect(await attemptRows(job.id)).toHaveLength(1);
    });

    it("並行して 6 件確定しても 1 件だけ completed で、attempt は 1 行", async () => {
      const userId = await createUser();
      const { job } = await newJob(userId);
      await repository().claim({ jobId: job.id, leaseSeconds: 300 });
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          repository().complete({
            jobId: job.id,
            status: "fallback",
            model: `m${index}`,
            result: { ...result, source: "fallback", fallbackReason: "disabled" },
            attempt: attempt("fallback"),
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome === "completed")).toHaveLength(1);
      expect(await attemptRows(job.id)).toHaveLength(1);
    });

    it("release は running を queued に戻して error の attempt を記録し、次の確定は attempt 2", async () => {
      const userId = await createUser();
      const { job } = await newJob(userId);
      await repository().claim({ jobId: job.id, leaseSeconds: 300 });
      await repository().release({ jobId: job.id, attempt: attempt("error") });
      expect((await repository().findById({ actorUserId: userId, jobId: job.id }))?.status).toBe(
        "queued",
      );

      // queued の job への release は何もしない
      await repository().release({ jobId: job.id, attempt: attempt("error") });
      expect(await attemptRows(job.id)).toHaveLength(1);

      await repository().claim({ jobId: job.id, leaseSeconds: 300 });
      await repository().complete({
        jobId: job.id,
        status: "succeeded",
        model: "m",
        result,
        attempt: attempt("succeeded"),
      });
      const rows = await attemptRows(job.id);
      expect(rows.map((row) => [row.attemptNo, row.outcome])).toEqual([
        [1, "error"],
        [2, "succeeded"],
      ]);
    });
  });

  describe("DB 制約(AJOB-INV-005)", () => {
    async function runningJob(): Promise<string> {
      const userId = await createUser();
      const { job } = await newJob(userId);
      await repository().claim({ jobId: job.id, leaseSeconds: 300 });
      return job.id;
    }

    it("succeeded に result_json がない/failed に failure_code がない/result が object でない更新は拒否される", async () => {
      const a = await runningJob();
      await expect(
        prisma.$executeRaw`UPDATE ai_jobs SET status = 'succeeded' WHERE public_id = ${a}::uuid`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE ai_jobs SET status = 'failed' WHERE public_id = ${a}::uuid`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE ai_jobs SET status = 'succeeded', result_json = '[]'::jsonb WHERE public_id = ${a}::uuid`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE ai_jobs SET result_json = '{}'::jsonb WHERE public_id = ${a}::uuid`,
      ).rejects.toThrow(); // running なのに result あり
      await expect(
        prisma.$executeRaw`UPDATE ai_jobs SET kind = 'other' WHERE public_id = ${a}::uuid`,
      ).rejects.toThrow();
    });

    it("attempt の attempt_no / outcome / latency の不正値は拒否される", async () => {
      const jobId = await runningJob();
      const internal = await prisma.aiJob.findFirstOrThrow({ where: { publicId: jobId } });
      const insert = (attemptNo: number, outcome: string, latency: number | null) =>
        prisma.$executeRaw`INSERT INTO ai_job_attempts (ai_job_id, attempt_no, started_at, outcome, latency_ms)
          VALUES (${internal.id}, ${attemptNo}, now(), ${outcome}, ${latency})`;
      await expect(insert(0, "succeeded", 1)).rejects.toThrow();
      await expect(insert(1, "unknown", 1)).rejects.toThrow();
      await expect(insert(1, "succeeded", -1)).rejects.toThrow();
      await expect(insert(1, "succeeded", null)).resolves.toBeDefined();
    });
  });
});

describe("パイプライン全体(実 DB + inline queue + fake provider)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let sequence = 0;

  async function createUser(): Promise<string> {
    sequence += 1;
    const label = `ai-pipeline-user-${sequence}`;
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}@example.com`,
        emailNormalized: `${label}@example.com`,
        passwordHash: "hash",
      },
    });
    return user.id.toString();
  }

  /** composition root(apps/web・apps/workers)と同じ配線。 */
  function wire(
    script: readonly FakeAiCoachStep[],
    options: { publicationEnabled?: boolean } = {},
  ) {
    const coach = createFakeAiCoach(script);
    const jobRepository = createPrismaAiJobRepository(prisma);
    const reviewRepository = createPrismaWeeklyReviewRepository(prisma);
    const habitRepository = createPrismaHabitRepository(prisma);
    const processDeps = {
      reviewRepository,
      habitRepository,
      jobRepository,
      now: clock,
      generate: {
        coach,
        audit: createNoopAiAuditSink(),
        policy: { managedTerms: [], referenceExcerpts: [] },
        publicationEnabled: options.publicationEnabled ?? true,
        config: {
          promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
          attemptTimeoutMs: 1000,
          baseBackoffMs: 1,
          maxBackoffMs: 2,
        },
        sleep: async () => {},
        random: () => 0,
      },
    };
    const queue = createInlineAiJobQueue(async (message, receiveCount) => {
      const { batchItemFailures } = await handleAiJobMessages(processDeps, {
        Records: [
          {
            messageId: message.jobId,
            body: JSON.stringify(message),
            attributes: { ApproximateReceiveCount: String(receiveCount) },
          },
        ],
      });
      return batchItemFailures.length === 0 ? "done" : "retry";
    });
    const requestDeps = {
      reviewRepository,
      habitRepository,
      jobRepository,
      queue,
      config: {
        promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
        provider: "fake",
        model: "fake-model-1",
      },
      now: clock,
    };
    return { coach, queue, jobRepository, requestDeps, processDeps };
  }

  async function completedReview(userId: string, weekStart = WEEK): Promise<string> {
    const habitRepository = createPrismaHabitRepository(prisma);
    await createHabitUseCase(
      { habitRepository, idGenerator: createUuidGenerator(), now: clock },
      {
        actorUserId: userId,
        kind: "build",
        name: "水を飲む",
        purpose: "健康維持",
        cue: "起床直後",
        minimumAction: "コップ1杯",
        schedule: {
          effectiveFrom: "2025-01-01",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          targetCount: 1,
        },
      },
    );
    const reviewRepository = createPrismaWeeklyReviewRepository(prisma);
    const { review } = await createWeeklyReviewUseCase(
      {
        reviewRepository,
        habitRepository,
        entryRepository: createPrismaHabitEntryRepository(prisma),
        checkInRepository: createPrismaDailyCheckInRepository(prisma),
        profileRepository: createPrismaProfileRepository(prisma),
        now: clock,
      },
      { actorUserId: userId, weekStart },
    );
    await updateWeeklyReviewUseCase(
      { reviewRepository, now: clock },
      { actorUserId: userId, reviewId: review.id, reflection: "よく続いた", complete: true },
    );
    return review.id;
  }

  beforeAll(async () => {
    container = await startPostgresContainer();
    migrateDeploy(container.getConnectionUri());
    prisma = createPrismaClient(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it("依頼(queued) → worker 処理 → 取得(succeeded)。結果は契約 schema を満たす", async () => {
    const userId = await createUser();
    const reviewId = await completedReview(userId);
    const w = wire([]);

    const { job, created } = await requestWeeklyAnalysisUseCase(w.requestDeps, {
      actorUserId: userId,
      reviewId,
    });
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    // 依頼の時点では provider は呼ばれていない(非同期)
    expect(w.coach.calls).toHaveLength(0);

    await w.queue.flush();

    const done = await getAiJobUseCase(
      { jobRepository: w.jobRepository },
      { actorUserId: userId, jobId: job.id },
    );
    expect(done.status).toBe("succeeded");
    expect(aiJobResultV1Schema.safeParse(done.result).success).toBe(true);
    expect(done.result?.source).toBe("ai");
    expect(w.coach.calls).toHaveLength(1);
    expect((await prisma.aiJobAttempt.findMany()).filter(() => true).length).toBeGreaterThan(0);
  });

  it("同じ依頼を何度しても job は 1 件で provider は 1 回、結果は同じ", async () => {
    const userId = await createUser();
    const reviewId = await completedReview(userId);
    const w = wire([]);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        requestWeeklyAnalysisUseCase(w.requestDeps, { actorUserId: userId, reviewId }),
      ),
    );
    await w.queue.flush();

    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await prisma.aiJob.count({ where: { userId: BigInt(userId) } })).toBe(1);
    expect(w.coach.calls).toHaveLength(1);
    const job = await getAiJobUseCase(
      { jobRepository: w.jobRepository },
      { actorUserId: userId, jobId: results[0]?.job.id ?? "" },
    );
    expect(job.status).toBe("succeeded");
  });

  it("provider が 429 を返し続けると fallback で完結し、ユーザーは pending のままにならない", async () => {
    const userId = await createUser();
    const reviewId = await completedReview(userId);
    const w = wire(
      Array.from({ length: 3 }, () => ({ kind: "error", errorKind: "rate_limited" }) as const),
    );

    const { job } = await requestWeeklyAnalysisUseCase(w.requestDeps, {
      actorUserId: userId,
      reviewId,
    });
    await w.queue.flush();

    const done = await getAiJobUseCase(
      { jobRepository: w.jobRepository },
      { actorUserId: userId, jobId: job.id },
    );
    expect(done.status).toBe("fallback");
    expect(done.result).toMatchObject({
      source: "fallback",
      fallbackReason: "provider_unavailable",
    });
    expect(w.coach.calls).toHaveLength(3);
  });

  it("公開 flag が無効なら provider を呼ばず fallback(disabled)", async () => {
    const userId = await createUser();
    const reviewId = await completedReview(userId);
    const w = wire([], { publicationEnabled: false });
    const { job } = await requestWeeklyAnalysisUseCase(w.requestDeps, {
      actorUserId: userId,
      reviewId,
    });
    await w.queue.flush();
    const done = await getAiJobUseCase(
      { jobRepository: w.jobRepository },
      { actorUserId: userId, jobId: job.id },
    );
    expect(done.result).toMatchObject({ source: "fallback", fallbackReason: "disabled" });
    expect(w.coach.calls).toHaveLength(0);
  });

  it("draft のレビューは依頼できず、他ユーザーは job を取得できない", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const reviewId = await completedReview(userA);
    const w = wire([]);

    const { job } = await requestWeeklyAnalysisUseCase(w.requestDeps, {
      actorUserId: userA,
      reviewId,
    });
    await w.queue.flush();
    await expect(
      getAiJobUseCase({ jobRepository: w.jobRepository }, { actorUserId: userB, jobId: job.id }),
    ).rejects.toBeInstanceOf(AiJobNotFoundError);

    // 確定していない週
    const habitRepository = createPrismaHabitRepository(prisma);
    const reviewRepository = createPrismaWeeklyReviewRepository(prisma);
    const { review } = await createWeeklyReviewUseCase(
      {
        reviewRepository,
        habitRepository,
        entryRepository: createPrismaHabitEntryRepository(prisma),
        checkInRepository: createPrismaDailyCheckInRepository(prisma),
        profileRepository: createPrismaProfileRepository(prisma),
        now: clock,
      },
      { actorUserId: userA, weekStart: "2025-12-29" },
    );
    await expect(
      requestWeeklyAnalysisUseCase(w.requestDeps, { actorUserId: userA, reviewId: review.id }),
    ).rejects.toBeInstanceOf(WeeklyReviewNotCompletedError);
  });

  it(`同時実行中の job が ${AI_JOB_MAX_ACTIVE_PER_USER} 件に達すると新規は拒否される(実 DB の件数)`, async () => {
    const userId = await createUser();
    const w = wire([]);
    // queue に流さない(queued のまま溜める)ため、投入を無効にした queue を使う。
    const idleQueue = { enqueue: async () => {} };
    const weeks = ["2025-12-08", "2025-12-15", "2025-12-22", "2025-12-29"];
    const ids: string[] = [];
    for (const weekStart of weeks) ids.push(await completedReview(userId, weekStart));

    for (const reviewId of ids.slice(0, AI_JOB_MAX_ACTIVE_PER_USER)) {
      await requestWeeklyAnalysisUseCase(
        { ...w.requestDeps, queue: idleQueue },
        { actorUserId: userId, reviewId },
      );
    }
    await expect(
      requestWeeklyAnalysisUseCase(
        { ...w.requestDeps, queue: idleQueue },
        { actorUserId: userId, reviewId: ids[AI_JOB_MAX_ACTIVE_PER_USER] ?? "" },
      ),
    ).rejects.toThrow(/limit/);
  });

  it("claim 済みの job を別 worker が処理しようとしても二重実行しない(provider 1 回)", async () => {
    const userId = await createUser();
    const reviewId = await completedReview(userId);
    const w = wire([]);
    const idleQueue = { enqueue: async () => {} };
    const { job } = await requestWeeklyAnalysisUseCase(
      { ...w.requestDeps, queue: idleQueue },
      { actorUserId: userId, reviewId },
    );

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        processAiJobUseCase(w.processDeps, { jobId: job.id, receiveCount: 1 }),
      ),
    );
    expect(w.coach.calls).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "done").length).toBeGreaterThanOrEqual(1);
    const done = await getAiJobUseCase(
      { jobRepository: w.jobRepository },
      { actorUserId: userId, jobId: job.id },
    );
    expect(done.status).toBe("succeeded");
    expect(await prisma.aiJobAttempt.count({ where: { aiJob: { publicId: job.id } } })).toBe(1);
  });
});

describe("Migration t303 の upgrade(直前の Migration まで適用済みの DB から)", () => {
  it("既存の schema(既存行あり)に適用でき、適用後に制約が働く", async () => {
    const upgradeContainer = await startPostgresContainer();
    try {
      const migrationsDir = path.join(infrastructureRoot, "database", "migrations");
      const names = fs
        .readdirSync(migrationsDir)
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
      expect(names).toContain(T303_MIGRATION);

      const env = { ...process.env, DATABASE_URL: upgradeContainer.getConnectionUri() };
      const before = names.filter((name) => name < T303_MIGRATION);
      const staging = fs.mkdtempSync(path.join(infrastructureRoot, ".t303-upgrade-"));
      const stagingConfig = path.join(infrastructureRoot, ".t303-upgrade.config.ts");
      try {
        fs.copyFileSync(
          path.join(migrationsDir, "migration_lock.toml"),
          path.join(staging, "migration_lock.toml"),
        );
        for (const name of before) {
          fs.cpSync(path.join(migrationsDir, name), path.join(staging, name), { recursive: true });
        }
        // 一時 Migration ディレクトリを指す config を一時ファイルとして作る(本物の config は変更しない)。
        fs.writeFileSync(
          stagingConfig,
          `import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "database/schema.prisma",
  migrations: { path: ${JSON.stringify(staging)} },
  datasource: { url: process.env["DATABASE_URL"] },
});
`,
        );
        execFileSync(prismaCli, ["migrate", "deploy", "--config", stagingConfig], {
          cwd: infrastructureRoot,
          env,
          stdio: "pipe",
        });
      } finally {
        fs.rmSync(stagingConfig, { force: true });
        fs.rmSync(staging, { recursive: true, force: true });
      }

      const client = createPrismaClient(upgradeContainer.getConnectionUri());
      try {
        const user = await client.user.create({
          data: {
            authSubject: "credentials:upgrade-ai@example.com",
            emailNormalized: "upgrade-ai@example.com",
            passwordHash: "hash",
          },
        });
        // t303 適用前の schema に、制約に適合する既存行を入れておく。
        await client.$executeRaw`
          INSERT INTO ai_jobs (user_id, kind, subject_type, subject_public_id, prompt_version,
                               output_schema_version, provider, model, input_fingerprint)
          VALUES (${user.id}, 'weekly_improvement', 'weekly_review', ${SUBJECT}::uuid, 'p', '1',
                  'fake', 'm', 'fp')`;

        migrateDeploy(upgradeContainer.getConnectionUri());

        expect(await client.aiJob.count({ where: { userId: user.id } })).toBe(1);
        // 冪等キーの unique が働く
        await expect(
          client.$executeRaw`
            INSERT INTO ai_jobs (user_id, kind, subject_type, subject_public_id, prompt_version,
                                 output_schema_version, provider, model, input_fingerprint)
            VALUES (${user.id}, 'weekly_improvement', 'weekly_review', ${SUBJECT}::uuid, 'p', '1',
                    'fake', 'm', 'fp')`,
        ).rejects.toThrow();
        const constraints = await client.$queryRaw<{ conname: string }[]>`
          SELECT conname FROM pg_constraint
          WHERE conrelid IN ('ai_jobs'::regclass, 'ai_job_attempts'::regclass)
            AND contype = 'c'
          ORDER BY conname`;
        expect(constraints.map((row) => row.conname)).toEqual([
          "ai_job_attempts_attempt_no_check",
          "ai_job_attempts_latency_check",
          "ai_job_attempts_outcome_check",
          "ai_jobs_failure_code_check",
          "ai_jobs_kind_check",
          "ai_jobs_result_check",
          "ai_jobs_status_check",
        ]);
        const indexes = await client.$queryRaw<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes WHERE indexname = 'ai_jobs_idempotency_uidx'`;
        expect(indexes).toHaveLength(1);
      } finally {
        await client.$disconnect();
      }
    } finally {
      await upgradeContainer.stop();
    }
  }, 180_000);
});
