import { InvalidPasswordError, signUp } from "@habit-app/application";
import { signUpRequestSchema } from "@habit-app/contracts";
import { NextResponse } from "next/server";

import { getAuthContainer } from "@/server/auth-container";
import { parseJsonBody, passwordPolicyViolationResponse } from "@/server/http";

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, signUpRequestSchema);
  if (!parsed.ok) return parsed.response;

  const { authRepository, passwordHasher, tokenGenerator, emailSender, clock } =
    await getAuthContainer();

  try {
    const result = await signUp(
      { authRepository, passwordHasher, tokenGenerator, emailSender, now: clock },
      parsed.data,
    );
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof InvalidPasswordError) {
      return passwordPolicyViolationResponse("password", error.message);
    }
    throw error;
  }
}
