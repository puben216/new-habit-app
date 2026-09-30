import { resendVerification } from "@habit-app/application";
import { resendVerificationRequestSchema } from "@habit-app/contracts";
import { NextResponse } from "next/server";

import { getAuthContainer } from "@/server/auth-container";
import { parseJsonBody } from "@/server/http";

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, resendVerificationRequestSchema);
  if (!parsed.ok) return parsed.response;

  const { authRepository, tokenGenerator, emailSender, clock } = await getAuthContainer();

  const result = await resendVerification(
    { authRepository, tokenGenerator, emailSender, now: clock },
    parsed.data,
  );
  return NextResponse.json(result, { status: 202 });
}
