import { createProblemDetails, toFieldErrors, type ProblemDetails } from "@habit-app/contracts";
import { NextResponse } from "next/server";

import type { z } from "zod";

type ParsedBody<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly response: NextResponse<ProblemDetails> };

/**
 * `/api/v1/auth/*` の共通仕様(docs/specs/auth-adapter.md API and Events 節):
 * Content-Type: application/json、未知キー拒否、エラーは Problem Details 形式。
 * JSON parse 失敗・schema 違反(型/上限/未知キー)はすべて 422 とする。
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<ParsedBody<T>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        createProblemDetails({
          code: "invalid_request_body",
          message: "リクエストボディを JSON として解釈できません",
        }),
        { status: 422 },
      ),
    };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        createProblemDetails({
          code: "validation_failed",
          message: "入力値が不正です",
          fieldErrors: toFieldErrors(result.error.issues),
        }),
        { status: 422 },
      ),
    };
  }

  return { ok: true, data: result.data };
}

/** verify-email / password-reset confirm 共通(AUTH-003/AUTH-008): 理由を区別しない同一エラー。 */
export function invalidOrExpiredTokenResponse(): NextResponse<ProblemDetails> {
  return NextResponse.json(
    createProblemDetails({
      code: "invalid_or_expired_token",
      message: "token is invalid or expired",
    }),
    { status: 400 },
  );
}

/** signup / password-reset confirm 共通: password policy 違反(AUTH-002)。 */
export function passwordPolicyViolationResponse(
  field: "password" | "newPassword",
  message: string,
): NextResponse<ProblemDetails> {
  return NextResponse.json(
    createProblemDetails({
      code: "validation_failed",
      message: "入力値が不正です",
      fieldErrors: { [field]: [message] },
    }),
    { status: 422 },
  );
}
