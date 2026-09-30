import { confirmPasswordReset, InvalidPasswordError } from "@habit-app/application";
import { passwordResetConfirmRequestSchema } from "@habit-app/contracts";
import { NextResponse } from "next/server";

import { getAuthContainer } from "@/server/auth-container";
import {
  invalidOrExpiredTokenResponse,
  parseJsonBody,
  passwordPolicyViolationResponse,
} from "@/server/http";

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, passwordResetConfirmRequestSchema);
  if (!parsed.ok) return parsed.response;

  const { authRepository, passwordHasher, tokenGenerator, clock } = await getAuthContainer();

  try {
    const result = await confirmPasswordReset(
      { authRepository, passwordHasher, tokenGenerator, now: clock },
      parsed.data,
    );
    if (!result.reset) return invalidOrExpiredTokenResponse();

    return NextResponse.json({ reset: true }, { status: 200 });
  } catch (error) {
    if (error instanceof InvalidPasswordError) {
      return passwordPolicyViolationResponse("newPassword", error.message);
    }
    throw error;
  }
}
