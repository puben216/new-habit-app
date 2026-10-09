import {
  InvalidWeeklyReviewCursorError,
  ReviewWeekNotAllowedError,
  UserNotFoundError,
  WeeklyReviewAlreadyCompletedError,
  WeeklyReviewNotFoundError,
} from "@habit-app/application";
import type {
  CreateWeeklyReviewInput,
  CreateWeeklyReviewResult,
  GetWeeklyReviewInput,
  ListWeeklyReviewsInput,
  ListWeeklyReviewsResult,
  UpdateWeeklyReviewInput,
  WeeklyReview,
} from "@habit-app/application";
import {
  createWeeklyReviewRequestSchema,
  listWeeklyReviewsQuerySchema,
  toFieldErrors,
  updateWeeklyReviewRequestSchema,
  weeklyReviewIdParamSchema,
} from "@habit-app/contracts";
import type { WeeklyReviewListResponse, WeeklyReviewResponse } from "@habit-app/contracts";
import { InvalidWeeklyReviewError } from "@habit-app/domain";

import {
  invalidOriginResponse,
  isTrustedOrigin,
  jsonResponse,
  problemResponse,
  readJsonBody,
  unauthorizedResponse,
  validationFailedResponse,
} from "./habit-http";

/**
 * `/api/v1/weekly-reviews` の route handler 本体(docs/specs/weekly-review.md)。
 * route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 */

export interface WeeklyReviewUseCases {
  create(input: CreateWeeklyReviewInput): Promise<CreateWeeklyReviewResult>;
  get(input: GetWeeklyReviewInput): Promise<WeeklyReview>;
  list(input: ListWeeklyReviewsInput): Promise<ListWeeklyReviewsResult>;
  update(input: UpdateWeeklyReviewInput): Promise<WeeklyReview>;
}

export interface WeeklyReviewHandlerDeps {
  /** session から actor の user ID を取得する。未認証は null。 */
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  /** 状態変更メソッドで許可する Origin(例: `https://app.example.com`)。 */
  readonly allowedOrigin: string;
  readonly useCases: WeeklyReviewUseCases;
}

export interface WeeklyReviewRouteParams {
  readonly reviewId: string;
}

export interface WeeklyReviewHandlers {
  list(request: Request): Promise<Response>;
  create(request: Request): Promise<Response>;
  get(request: Request, params: WeeklyReviewRouteParams): Promise<Response>;
  update(request: Request, params: WeeklyReviewRouteParams): Promise<Response>;
}

const WEEK_NOT_REVIEWABLE_MESSAGES = {
  not_week_start: "週の開始日(プロフィールで設定した週の開始曜日)を指定してください",
  not_ended: "終了した週のみレビューを作成できます",
  too_old: "レビューを作成できる週の範囲(直近 52 週)を超えています",
} as const;

function reviewNotFoundResponse(): Response {
  return problemResponse(404, {
    code: "weekly_review_not_found",
    message: "週次レビューが見つかりません",
  });
}

/** use case が投げたエラーを HTTP 応答へ変換する。未知のエラーは null を返し、呼び出し側が再 throw する。 */
function mapWeeklyReviewError(error: unknown): Response | null {
  if (error instanceof ReviewWeekNotAllowedError) {
    return problemResponse(422, {
      code: "week_not_reviewable",
      message: "この週のレビューは作成できません",
      fieldErrors: { weekStart: [WEEK_NOT_REVIEWABLE_MESSAGES[error.reason]] },
    });
  }
  if (error instanceof WeeklyReviewNotFoundError) return reviewNotFoundResponse();
  if (error instanceof WeeklyReviewAlreadyCompletedError) {
    return problemResponse(409, {
      code: "weekly_review_already_completed",
      message: "確定済みの週次レビューは変更できません",
    });
  }
  if (error instanceof UserNotFoundError) {
    return problemResponse(404, { code: "user_not_found", message: "ユーザーが見つかりません" });
  }
  if (error instanceof InvalidWeeklyReviewCursorError) {
    return problemResponse(422, {
      code: "invalid_cursor",
      message: "cursor が不正です",
      fieldErrors: { cursor: ["cursor が不正です"] },
    });
  }
  if (error instanceof InvalidWeeklyReviewError) {
    // メッセージは項目名・数値のみで自由記述を含まない。
    return validationFailedResponse({ [error.field]: [error.message] });
  }
  return null;
}

function toWeeklyReviewResponse(review: WeeklyReview): WeeklyReviewResponse {
  return {
    id: review.id,
    weekStart: review.weekStart,
    weekEnd: review.weekEnd,
    timezone: review.timezone,
    status: review.status,
    summary: review.summary,
    reflection: review.reflection,
    completedAt: review.completedAt === null ? null : review.completedAt.toISOString(),
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

export function createWeeklyReviewHandlers(deps: WeeklyReviewHandlerDeps): WeeklyReviewHandlers {
  async function run(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      const response = mapWeeklyReviewError(error);
      if (response === null) throw error;
      return response;
    }
  }

  return {
    async list(request) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const query = listWeeklyReviewsQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return validationFailedResponse(toFieldErrors(query.error.issues));

      return run(async () => {
        const result = await deps.useCases.list({
          actorUserId,
          limit: query.data.limit,
          cursor: query.data.cursor,
        });
        const body: WeeklyReviewListResponse = {
          items: result.items.map(toWeeklyReviewResponse),
          nextCursor: result.nextCursor,
        };
        return jsonResponse(200, body);
      });
    },

    async create(request) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const parsed = await readJsonBody(request, createWeeklyReviewRequestSchema);
      if (!parsed.ok) return parsed.response;

      return run(async () => {
        const { review, created } = await deps.useCases.create({
          actorUserId,
          weekStart: parsed.data.weekStart,
        });
        return jsonResponse(
          created ? 201 : 200,
          toWeeklyReviewResponse(review),
          created ? { Location: `/api/v1/weekly-reviews/${review.id}` } : {},
        );
      });
    },

    async get(request, params) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const reviewId = weeklyReviewIdParamSchema.safeParse(params.reviewId);
      if (!reviewId.success) return reviewNotFoundResponse();

      return run(async () => {
        const review = await deps.useCases.get({ actorUserId, reviewId: reviewId.data });
        return jsonResponse(200, toWeeklyReviewResponse(review));
      });
    },

    async update(request, params) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const reviewId = weeklyReviewIdParamSchema.safeParse(params.reviewId);
      if (!reviewId.success) return reviewNotFoundResponse();

      const parsed = await readJsonBody(request, updateWeeklyReviewRequestSchema);
      if (!parsed.ok) return parsed.response;

      return run(async () => {
        const review = await deps.useCases.update({
          actorUserId,
          reviewId: reviewId.data,
          reflection: parsed.data.reflection,
          complete: parsed.data.status === "completed",
        });
        return jsonResponse(200, toWeeklyReviewResponse(review));
      });
    },
  };
}
