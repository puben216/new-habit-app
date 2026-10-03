import {
  HabitNotFoundError,
  HabitVersionConflictError,
  InvalidCursorError,
} from "@habit-app/application";
import type { HabitRecord } from "@habit-app/application";
import {
  HABIT_REQUEST_BODY_MAX_BYTES,
  createProblemDetails,
  toFieldErrors,
} from "@habit-app/contracts";
import type { HabitResponse } from "@habit-app/contracts";
import {
  HabitArchivedError,
  HabitDomainError,
  InvalidHabitDetailsError,
  InvalidHabitKindError,
  InvalidScheduleVersionError,
  OverlappingScheduleVersionError,
  UnsupportedScheduleChangeError,
} from "@habit-app/domain";

import type { z } from "zod";

/**
 * `/api/v1/habits` の HTTP 変換(docs/specs/habit-api.md API and Events 節)。
 * Request/Response のみに依存し Next.js に依存しないため、実 DB・Auth.js なしで Unit Test できる。
 * 応答にリクエスト本文・自由記述・内部エラーの詳細を含めない。
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function problemResponse(
  status: number,
  input: {
    readonly code: string;
    readonly message: string;
    readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  },
): Response {
  return Response.json(createProblemDetails(input), { status, headers: NO_STORE });
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function unauthorizedResponse(): Response {
  return problemResponse(401, { code: "unauthorized", message: "認証が必要です" });
}

export function habitNotFoundResponse(): Response {
  return problemResponse(404, { code: "habit_not_found", message: "習慣が見つかりません" });
}

/**
 * CSRF 対策(状態変更メソッド)。Origin ヘッダが許可 origin と一致すること。
 * Origin が無い場合は Sec-Fetch-Site: same-origin のみ許可する。
 */
export function isTrustedOrigin(request: Request, allowedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === allowedOrigin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export function invalidOriginResponse(): Response {
  return problemResponse(403, { code: "invalid_origin", message: "リクエストの送信元が不正です" });
}

function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/** body を上限付きで読む。上限超過は null(ストリームを打ち切る)。 */
async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

type ParsedBody<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly response: Response };

/** Content-Type 検証(415)、サイズ上限(413)、JSON/schema 検証(422)。 */
export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<ParsedBody<T>> {
  if (!isJsonContentType(request)) {
    return {
      ok: false,
      response: problemResponse(415, {
        code: "unsupported_media_type",
        message: "Content-Type は application/json である必要があります",
      }),
    };
  }
  const text = await readLimitedText(request, HABIT_REQUEST_BODY_MAX_BYTES);
  if (text === null) {
    return {
      ok: false,
      response: problemResponse(413, {
        code: "payload_too_large",
        message: "リクエストボディが大きすぎます",
      }),
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: problemResponse(422, {
        code: "invalid_request_body",
        message: "リクエストボディを JSON として解釈できません",
      }),
    };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, response: validationFailedResponse(toFieldErrors(result.error.issues)) };
  }
  return { ok: true, data: result.data };
}

export function validationFailedResponse(fieldErrors: Record<string, readonly string[]>): Response {
  return problemResponse(422, {
    code: "validation_failed",
    message: "入力値が不正です",
    fieldErrors,
  });
}

/**
 * use case が投げたエラーを HTTP 応答へ変換する。未知のエラーは null を返し、呼び出し側が再 throw する
 * (内部エラーの詳細は応答に含めない)。
 */
export function mapHabitError(error: unknown): Response | null {
  if (error instanceof HabitNotFoundError) return habitNotFoundResponse();
  if (error instanceof HabitVersionConflictError) {
    return problemResponse(409, {
      code: "version_conflict",
      message: "他の更新と競合しました。最新の内容を取得して再実行してください",
    });
  }
  if (error instanceof HabitArchivedError) {
    return problemResponse(409, {
      code: "habit_archived",
      message: "アーカイブ済みの習慣は更新できません",
    });
  }
  if (error instanceof InvalidCursorError) {
    return validationFailedResponse({ cursor: ["cursor が不正です"] });
  }
  // Domain の不変条件違反。メッセージは項目名・数値・日付のみを含み自由記述を含まない。
  if (
    error instanceof InvalidScheduleVersionError ||
    error instanceof OverlappingScheduleVersionError
  ) {
    return validationFailedResponse({ schedule: [error.message] });
  }
  if (error instanceof UnsupportedScheduleChangeError) {
    return validationFailedResponse({ "schedule.effectiveFrom": [error.message] });
  }
  if (error instanceof InvalidHabitKindError) {
    return validationFailedResponse({ kind: ["kind が不正です"] });
  }
  if (error instanceof InvalidHabitDetailsError) {
    return validationFailedResponse({ _root: [error.message] });
  }
  if (error instanceof HabitDomainError) {
    return validationFailedResponse({ _root: ["入力値が不正です"] });
  }
  return null;
}

export function toHabitResponse(record: HabitRecord): HabitResponse {
  const { habit } = record;
  return {
    id: habit.id,
    kind: habit.kind,
    name: habit.name,
    purpose: habit.purpose,
    cue: habit.cue,
    minimumAction: habit.minimumAction,
    replacementAction: habit.replacementAction,
    status: habit.status,
    version: record.version,
    scheduleVersions: habit.scheduleVersions.map((version) => ({
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      daysOfWeek: [...version.daysOfWeek],
      targetCount: version.targetCount,
    })),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
