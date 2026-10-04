import {
  CheckInDateOutOfRangeError,
  DailyCheckInNotFoundError,
  UserNotFoundError,
} from "@habit-app/application";
import type {
  DailyCheckInRecord,
  GetDailyCheckInInput,
  UpsertDailyCheckInInput,
} from "@habit-app/application";
import { checkInDateParamSchema, upsertDailyCheckInRequestSchema } from "@habit-app/contracts";
import type { DailyCheckInResponse } from "@habit-app/contracts";
import { InvalidDailyCheckInError } from "@habit-app/domain";

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
 * `/api/v1/daily-check-ins/{date}` の route handler 本体(docs/specs/daily-check-in.md)。
 * route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 */

export interface CheckInUseCases {
  get(input: GetDailyCheckInInput): Promise<DailyCheckInRecord>;
  upsert(input: UpsertDailyCheckInInput): Promise<DailyCheckInRecord>;
}

export interface CheckInHandlerDeps {
  /** session から actor の user ID を取得する。未認証は null。 */
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  /** 状態変更メソッドで許可する Origin(例: `https://app.example.com`)。 */
  readonly allowedOrigin: string;
  readonly useCases: CheckInUseCases;
}

export interface CheckInRouteParams {
  readonly date: string;
}

export interface CheckInHandlers {
  get(request: Request, params: CheckInRouteParams): Promise<Response>;
  upsert(request: Request, params: CheckInRouteParams): Promise<Response>;
}

/** use case が投げたエラーを HTTP 応答へ変換する。未知のエラーは null を返し、呼び出し側が再 throw する。 */
function mapCheckInError(error: unknown): Response | null {
  if (error instanceof CheckInDateOutOfRangeError) {
    return problemResponse(422, {
      code: "check_in_date_out_of_range",
      message: "チェックインできるのは今日から過去 7 日までの日付です",
      fieldErrors: { date: ["チェックインできる日付の範囲外です"] },
    });
  }
  if (error instanceof DailyCheckInNotFoundError) {
    return problemResponse(404, {
      code: "check_in_not_found",
      message: "チェックインが見つかりません",
    });
  }
  if (error instanceof UserNotFoundError) {
    return problemResponse(404, { code: "user_not_found", message: "ユーザーが見つかりません" });
  }
  if (error instanceof InvalidDailyCheckInError) {
    // メッセージは項目名・数値のみで自由記述を含まない。
    return problemResponse(422, {
      code: "invalid_check_in",
      message: "チェックインの内容が不正です",
      fieldErrors: { [error.field]: [error.message] },
    });
  }
  return null;
}

function toCheckInResponse(record: DailyCheckInRecord): DailyCheckInResponse {
  return {
    date: record.date,
    mood: record.mood,
    difficulty: record.difficulty,
    note: record.note,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function invalidDateResponse(): Response {
  return validationFailedResponse({
    date: ["日付は YYYY-MM-DD 形式の実在する暦日で指定してください"],
  });
}

export function createCheckInHandlers(deps: CheckInHandlerDeps): CheckInHandlers {
  async function run(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      const response = mapCheckInError(error);
      if (response === null) throw error;
      return response;
    }
  }

  return {
    async get(request, params) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const date = checkInDateParamSchema.safeParse(params.date);
      if (!date.success) return invalidDateResponse();

      return run(async () => {
        const record = await deps.useCases.get({ actorUserId, date: date.data });
        return jsonResponse(200, toCheckInResponse(record));
      });
    },

    async upsert(request, params) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const date = checkInDateParamSchema.safeParse(params.date);
      if (!date.success) return invalidDateResponse();

      const parsed = await readJsonBody(request, upsertDailyCheckInRequestSchema);
      if (!parsed.ok) return parsed.response;

      return run(async () => {
        const record = await deps.useCases.upsert({
          actorUserId,
          date: date.data,
          mood: parsed.data.mood,
          difficulty: parsed.data.difficulty,
          note: parsed.data.note,
        });
        return jsonResponse(200, toCheckInResponse(record));
      });
    },
  };
}
