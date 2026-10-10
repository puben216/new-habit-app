import { AI_SCHEMA_VERSION, aiJobResultV1Schema } from "@habit-app/contracts";
import type { AiJobResultV1, WeeklyImprovementPlanV1 } from "@habit-app/contracts";

import type { Clock } from "../auth";
import type { HabitRepositoryPort } from "../habits/ports";
import { UserNotFoundError, WeeklyReviewNotFoundError } from "../tracking/errors";
import { listAllActiveHabits } from "../tracking/use-cases";
import type { WeeklyReviewRepositoryPort } from "../tracking/weekly-review-ports";
import { getWeeklyReviewUseCase } from "../tracking/weekly-review-use-cases";
import type { WeeklyReview } from "../tracking/weekly-review-use-cases";
import { CONTENT_VALIDATOR_VERSION } from "./content-validator";
import { SAFE_FALLBACK_VERSION, buildWeeklyImprovementFallback } from "./fallback";
import { generateSafeCoaching } from "./generate-safe-coaching";
import type { GenerateSafeCoachingDeps, SafeCoachingResult } from "./generate-safe-coaching";
import {
  AiJobLimitReachedError,
  AiJobNotFoundError,
  AiQueueUnavailableError,
  AnalysisInputInvalidError,
  CorruptedAiJobError,
  WeeklyReviewNotCompletedError,
} from "./job-errors";
import type {
  AiJobAttemptRecord,
  AiJobQueuePort,
  AiJobRecord,
  AiJobRepositoryPort,
} from "./job-ports";
import {
  NIL_SUBJECT_ID,
  buildWeeklyImprovementInput,
  fingerprintWeeklyInput,
} from "./weekly-input";
import type { ActiveHabitDetail } from "./weekly-input";

/**
 * AI job の use case(docs/specs/ai-queue-pipeline.md)。AI 本文は必ず `generateSafeCoaching`(T-302)を
 * 経由し、ここで provider の結果を直接扱わない(AJOB-INV-007)。
 */

/** 1 ユーザーの同時実行中(queued/running)job の上限(AJOB-001)。 */
export const AI_JOB_MAX_ACTIVE_PER_USER = 3;
/** `running` の lease(秒)。Lambda timeout より十分長く、SQS visibility timeout 以下にする(AJOB-003)。 */
export const AI_JOB_LEASE_SECONDS = 300;
/** この受信回数に達した失敗は、規則ベースの fallback で確定して ack する(AJOB-004)。SQS の maxReceiveCount と一致させる。 */
export const AI_JOB_MAX_RECEIVE = 3;

export const WEEKLY_IMPROVEMENT_PROMPT_VERSION = "weekly-improvement/1";
export const WEEKLY_IMPROVEMENT_KIND = "weekly_improvement";
export const WEEKLY_REVIEW_SUBJECT_TYPE = "weekly_review";

export interface AiJobConfig {
  readonly promptVersion: string;
  /** `ai_jobs.provider`(設定値。例: `fake`)。 */
  readonly provider: string;
  /** 実行前の `ai_jobs.model`(確定時に実際の値で更新される)。 */
  readonly model: string;
}

/** API に返す job。provider/model/fingerprint/user を含まない。 */
export interface AiJob {
  readonly id: string;
  readonly kind: AiJobRecord["kind"];
  readonly status: AiJobRecord["status"];
  readonly subject: { readonly type: string; readonly id: string };
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
  readonly result: AiJobResultV1 | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toAiJob(record: AiJobRecord): AiJob {
  let result: AiJobResultV1 | null = null;
  if (record.result !== null) {
    const parsed = aiJobResultV1Schema.safeParse(record.result);
    if (!parsed.success) throw new CorruptedAiJobError();
    result = parsed.data;
  }
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    subject: { type: record.subjectType, id: record.subjectId },
    promptVersion: record.promptVersion,
    outputSchemaVersion: record.outputSchemaVersion,
    result,
    failureCode: record.failureCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

interface WeeklySourceDeps {
  readonly reviewRepository: WeeklyReviewRepositoryPort;
  readonly habitRepository: HabitRepositoryPort;
}

/** レビューと active 習慣の cue/minimumAction を読む。レビューがなければ WeeklyReviewNotFoundError。 */
async function loadWeeklySource(
  deps: WeeklySourceDeps,
  actorUserId: string,
  reviewId: string,
): Promise<{ review: WeeklyReview; habits: ReadonlyMap<string, ActiveHabitDetail> }> {
  const review = await getWeeklyReviewUseCase(
    { reviewRepository: deps.reviewRepository },
    { actorUserId, reviewId },
  );
  const habits = new Map<string, ActiveHabitDetail>();
  for (const { habit } of await listAllActiveHabits(deps.habitRepository, actorUserId)) {
    habits.set(habit.id, { cue: habit.cue, minimumAction: habit.minimumAction });
  }
  return { review, habits };
}

export interface RequestWeeklyAnalysisDeps extends WeeklySourceDeps {
  readonly jobRepository: AiJobRepositoryPort;
  readonly queue: AiJobQueuePort;
  readonly config: AiJobConfig;
  readonly now: Clock;
}

export interface RequestWeeklyAnalysisInput {
  readonly actorUserId: string;
  readonly reviewId: string;
}

export interface RequestWeeklyAnalysisResult {
  readonly job: AiJob;
  /** この呼び出しで新規作成したか(false は既存の job を返したことを表す)。 */
  readonly created: boolean;
}

/**
 * 確定済みの週次レビューの分析 job を依頼する(AJOB-001/002)。同じ入力は同じ job に収束する。
 *
 * @throws {WeeklyReviewNotFoundError} 存在しない、または他ユーザーのレビュー
 * @throws {WeeklyReviewNotCompletedError} 確定していない
 * @throws {AnalysisInputInvalidError} 入力を組み立てられない
 * @throws {AiJobLimitReachedError} 同時実行中の job が上限
 * @throws {AiQueueUnavailableError} queue へ投入できない(job は queued のまま残る)
 * @throws {UserNotFoundError} actor の user が存在しない
 */
export async function requestWeeklyAnalysisUseCase(
  deps: RequestWeeklyAnalysisDeps,
  input: RequestWeeklyAnalysisInput,
): Promise<RequestWeeklyAnalysisResult> {
  const { actorUserId, reviewId } = input;
  const { review, habits } = await loadWeeklySource(deps, actorUserId, reviewId);
  if (review.status !== "completed") throw new WeeklyReviewNotCompletedError();

  const built = buildWeeklyImprovementInput(review, habits, NIL_SUBJECT_ID);
  if (!built.ok) throw new AnalysisInputInvalidError();
  const inputFingerprint = fingerprintWeeklyInput(built.input);

  const key = {
    actorUserId,
    kind: WEEKLY_IMPROVEMENT_KIND,
    subjectId: review.id,
    promptVersion: deps.config.promptVersion,
    inputFingerprint,
  } as const;

  let job = await deps.jobRepository.findByInput(key);
  let created = false;
  if (job === null) {
    if ((await deps.jobRepository.countActive({ actorUserId })) >= AI_JOB_MAX_ACTIVE_PER_USER) {
      throw new AiJobLimitReachedError();
    }
    const saved = await deps.jobRepository.createOrGet({
      actorUserId,
      kind: WEEKLY_IMPROVEMENT_KIND,
      subjectType: WEEKLY_REVIEW_SUBJECT_TYPE,
      subjectId: review.id,
      promptVersion: deps.config.promptVersion,
      outputSchemaVersion: AI_SCHEMA_VERSION,
      provider: deps.config.provider,
      model: deps.config.model,
      inputFingerprint,
      now: deps.now(),
    });
    if (saved === null) throw new UserNotFoundError();
    job = saved.job;
    created = saved.created;
  }

  // 新規、または投入漏れの回復(queued のまま残っている既存 job)。重複投入は claim で無害(AJOB-003)。
  if (job.status === "queued") {
    try {
      await deps.queue.enqueue({ v: 1, jobId: job.id });
    } catch {
      throw new AiQueueUnavailableError();
    }
  }
  return { job: toAiJob(job), created };
}

export interface GetAiJobDeps {
  readonly jobRepository: AiJobRepositoryPort;
}

/**
 * 自分の job を返す(AJOB-005)。
 *
 * @throws {AiJobNotFoundError} 存在しない、または他ユーザーの job
 */
export async function getAiJobUseCase(
  deps: GetAiJobDeps,
  input: { readonly actorUserId: string; readonly jobId: string },
): Promise<AiJob> {
  const record = await deps.jobRepository.findById(input);
  if (record === null) throw new AiJobNotFoundError();
  return toAiJob(record);
}

export interface ProcessAiJobDeps extends WeeklySourceDeps {
  readonly jobRepository: AiJobRepositoryPort;
  readonly generate: GenerateSafeCoachingDeps;
  readonly now: Clock;
}

export interface ProcessAiJobInput {
  readonly jobId: string;
  /** SQS の `ApproximateReceiveCount`(1 始まり)。 */
  readonly receiveCount: number;
}

/** `done`: message を ack してよい。`retry`: 再配送に回す(batchItemFailures に入れる)。 */
export type ProcessAiJobOutcome = "done" | "retry";

function toJobResult(result: SafeCoachingResult<WeeklyImprovementPlanV1>): AiJobResultV1 {
  return {
    schemaVersion: 1,
    source: result.source,
    output: result.output,
    contentSafety: {
      ...result.contentSafety,
      reasonCodes: [...result.contentSafety.reasonCodes],
    },
    fallbackReason: result.source === "fallback" ? result.fallbackReason : null,
  };
}

function exhaustedResult(): AiJobResultV1 {
  return {
    schemaVersion: 1,
    source: "fallback",
    output: buildWeeklyImprovementFallback(),
    contentSafety: {
      status: "fallback",
      reasonCodes: [],
      validatorVersion: CONTENT_VALIDATOR_VERSION,
      fallbackVersion: SAFE_FALLBACK_VERSION,
    },
    fallbackReason: "worker_exhausted",
  };
}

/**
 * queue message 1 件分の job を処理する(AJOB-003/004)。冪等で、重複配送・lease 切れの引き継ぎを扱う。
 * 例外は投げない(予期しない失敗は `retry`、または受信上限で fallback 確定の `done`)。
 */
export async function processAiJobUseCase(
  deps: ProcessAiJobDeps,
  input: ProcessAiJobInput,
): Promise<ProcessAiJobOutcome> {
  let claimed: AiJobRecord;
  try {
    const claim = await deps.jobRepository.claim({
      jobId: input.jobId,
      leaseSeconds: AI_JOB_LEASE_SECONDS,
    });
    switch (claim.status) {
      case "not_found":
      case "finished":
        return "done";
      case "in_progress":
        return "retry";
      case "claimed":
        claimed = claim.job;
        break;
      default: {
        const exhaustive: never = claim;
        return exhaustive;
      }
    }
  } catch {
    return "retry";
  }

  const startedAt = deps.now();
  const attemptOf = (
    outcome: AiJobAttemptRecord["outcome"],
    errorCategory: string | null,
  ): AiJobAttemptRecord => {
    const finishedAt = deps.now();
    return {
      outcome,
      startedAt,
      finishedAt,
      latencyMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      errorCategory,
    };
  };

  try {
    return await runClaimedJob(deps, claimed, attemptOf);
  } catch {
    return recoverFromWorkerFailure(deps, claimed, input.receiveCount, attemptOf);
  }
}

async function runClaimedJob(
  deps: ProcessAiJobDeps,
  job: AiJobRecord,
  attemptOf: (
    outcome: AiJobAttemptRecord["outcome"],
    category: string | null,
  ) => AiJobAttemptRecord,
): Promise<ProcessAiJobOutcome> {
  // 入力元が使えない失敗は再試行しても直らないため `failed` で確定する。`lost` も確定済みとして ack する。
  const fail = async (
    failureCode: "subject_unavailable" | "invalid_input",
  ): Promise<ProcessAiJobOutcome> => {
    await deps.jobRepository.complete({
      jobId: job.id,
      status: "failed",
      failureCode,
      attempt: attemptOf("failed", failureCode),
    });
    return "done";
  };

  let source: Awaited<ReturnType<typeof loadWeeklySource>>;
  try {
    source = await loadWeeklySource(deps, job.userId, job.subjectId);
  } catch (error) {
    if (error instanceof WeeklyReviewNotFoundError) return fail("subject_unavailable");
    throw error;
  }
  if (source.review.status !== "completed") return fail("subject_unavailable");

  const built = buildWeeklyImprovementInput(source.review, source.habits, job.id);
  if (!built.ok) return fail("invalid_input");

  const generated = await generateSafeCoaching(deps.generate, {
    purpose: "weekly_improvement",
    input: built.input,
  });
  const status = generated.source === "ai" ? "succeeded" : "fallback";
  await deps.jobRepository.complete({
    jobId: job.id,
    status,
    model: generated.source === "ai" ? generated.model : job.model,
    result: toJobResult(generated),
    attempt: attemptOf(status, generated.source === "fallback" ? generated.fallbackReason : null),
  });
  return "done";
}

/**
 * claim 後に予期しない失敗が起きた場合の回復(AJOB-004)。受信上限に達していれば規則ベースの
 * fallback で確定し、そうでなければ queued に戻して再配送に回す。回復自体の失敗も握りつぶして `retry`
 * とする(lease の期限切れが最後の安全網)。
 */
async function recoverFromWorkerFailure(
  deps: ProcessAiJobDeps,
  job: AiJobRecord,
  receiveCount: number,
  attemptOf: (
    outcome: AiJobAttemptRecord["outcome"],
    category: string | null,
  ) => AiJobAttemptRecord,
): Promise<ProcessAiJobOutcome> {
  if (receiveCount >= AI_JOB_MAX_RECEIVE) {
    try {
      await deps.jobRepository.complete({
        jobId: job.id,
        status: "fallback",
        model: job.model,
        result: exhaustedResult(),
        attempt: attemptOf("fallback", "worker_exhausted"),
      });
      return "done";
    } catch {
      return "retry";
    }
  }
  try {
    await deps.jobRepository.release({
      jobId: job.id,
      attempt: attemptOf("error", "worker_error"),
    });
  } catch {
    // lease の期限切れで後続の配送が引き継ぐ。
  }
  return "retry";
}
