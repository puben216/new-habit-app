import {
  AiJobLimitReachedError,
  AiJobNotFoundError,
  AiQueueUnavailableError,
  AnalysisInputInvalidError,
  UserNotFoundError,
  WeeklyReviewNotCompletedError,
  WeeklyReviewNotFoundError,
} from "@habit-app/application";
import type {
  AiJob,
  RequestWeeklyAnalysisInput,
  RequestWeeklyAnalysisResult,
} from "@habit-app/application";
import {
  aiJobIdParamSchema,
  requestWeeklyAnalysisBodySchema,
  weeklyReviewIdParamSchema,
} from "@habit-app/contracts";
import type { AiJobResponse } from "@habit-app/contracts";

import {
  invalidOriginResponse,
  isTrustedOrigin,
  jsonResponse,
  problemResponse,
  readJsonBody,
  unauthorizedResponse,
} from "./habit-http";

/**
 * `POST /api/v1/weekly-reviews/{reviewId}/analysis` と `GET /api/v1/ai-jobs/{jobId}` の handler 本体
 * (docs/specs/ai-queue-pipeline.md)。route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 */

export interface AiJobUseCases {
  requestAnalysis(input: RequestWeeklyAnalysisInput): Promise<RequestWeeklyAnalysisResult>;
  get(input: { readonly actorUserId: string; readonly jobId: string }): Promise<AiJob>;
}

export interface AiJobHandlerDeps {
  /** session から actor の user ID を取得する。未認証は null。 */
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  /** 状態変更メソッドで許可する Origin(例: `https://app.example.com`)。 */
  readonly allowedOrigin: string;
  readonly useCases: AiJobUseCases;
}

export interface AiJobHandlers {
  requestAnalysis(request: Request, params: { readonly reviewId: string }): Promise<Response>;
  get(request: Request, params: { readonly jobId: string }): Promise<Response>;
}

function reviewNotFoundResponse(): Response {
  return problemResponse(404, {
    code: "weekly_review_not_found",
    message: "週次レビューが見つかりません",
  });
}

function jobNotFoundResponse(): Response {
  return problemResponse(404, { code: "ai_job_not_found", message: "AI ジョブが見つかりません" });
}

/** use case が投げたエラーを HTTP 応答へ変換する。未知のエラーは null を返し、呼び出し側が再 throw する。 */
function mapAiJobError(error: unknown): Response | null {
  if (error instanceof WeeklyReviewNotFoundError) return reviewNotFoundResponse();
  if (error instanceof AiJobNotFoundError) return jobNotFoundResponse();
  if (error instanceof WeeklyReviewNotCompletedError) {
    return problemResponse(409, {
      code: "weekly_review_not_completed",
      message: "確定した週次レビューのみ分析できます",
    });
  }
  if (error instanceof AnalysisInputInvalidError) {
    return problemResponse(422, {
      code: "analysis_input_invalid",
      message: "このレビューの内容は分析の入力にできません",
    });
  }
  if (error instanceof AiJobLimitReachedError) {
    return problemResponse(429, {
      code: "ai_job_limit_reached",
      message: "実行中の分析が上限に達しています。完了してから再度お試しください",
    });
  }
  if (error instanceof AiQueueUnavailableError) {
    return problemResponse(503, {
      code: "queue_unavailable",
      message: "分析を開始できませんでした。しばらくしてから再度お試しください",
    });
  }
  if (error instanceof UserNotFoundError) {
    return problemResponse(404, { code: "user_not_found", message: "ユーザーが見つかりません" });
  }
  return null;
}

function toAiJobResponse(job: AiJob): AiJobResponse {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    subject: { type: job.subject.type, id: job.subject.id },
    promptVersion: job.promptVersion,
    outputSchemaVersion: job.outputSchemaVersion,
    result: job.result,
    failureCode: toFailureCode(job.failureCode),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function toFailureCode(value: string | null): AiJobResponse["failureCode"] {
  if (value === null) return null;
  if (value === "subject_unavailable" || value === "invalid_input") return value;
  // 未知の failure_code(データ破損)。内部詳細を応答に出さず、500 にする。
  throw new Error("persisted ai job has an unknown failure code");
}

/** body は不要。与えられた場合のみ、JSON の `{}` であることを検証する。 */
async function readOptionalEmptyBody(
  request: Request,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly response: Response }> {
  if (request.body === null || request.headers.get("content-length") === "0") return { ok: true };
  const parsed = await readJsonBody(request, requestWeeklyAnalysisBodySchema);
  return parsed.ok ? { ok: true } : { ok: false, response: parsed.response };
}

export function createAiJobHandlers(deps: AiJobHandlerDeps): AiJobHandlers {
  async function run(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      const response = mapAiJobError(error);
      if (response === null) throw error;
      return response;
    }
  }

  return {
    async requestAnalysis(request, params) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const reviewId = weeklyReviewIdParamSchema.safeParse(params.reviewId);
      if (!reviewId.success) return reviewNotFoundResponse();

      const body = await readOptionalEmptyBody(request);
      if (!body.ok) return body.response;

      return run(async () => {
        const { job, created } = await deps.useCases.requestAnalysis({
          actorUserId,
          reviewId: reviewId.data,
        });
        return jsonResponse(created ? 202 : 200, toAiJobResponse(job), {
          Location: `/api/v1/ai-jobs/${job.id}`,
        });
      });
    },

    async get(request, params) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const jobId = aiJobIdParamSchema.safeParse(params.jobId);
      if (!jobId.success) return jobNotFoundResponse();

      return run(async () => {
        const job = await deps.useCases.get({ actorUserId, jobId: jobId.data });
        return jsonResponse(200, toAiJobResponse(job));
      });
    },
  };
}
