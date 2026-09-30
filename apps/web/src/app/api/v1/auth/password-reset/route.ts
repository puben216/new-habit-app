import { requestPasswordReset } from "@habit-app/application";
import { passwordResetRequestSchema } from "@habit-app/contracts";
import { NextResponse } from "next/server";

import { getAuthContainer } from "@/server/auth-container";
import { parseJsonBody } from "@/server/http";

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, passwordResetRequestSchema);
  if (!parsed.ok) return parsed.response;

  const { authRepository, tokenGenerator, emailSender, clock } = await getAuthContainer();

  const result = await requestPasswordReset(
    { authRepository, tokenGenerator, emailSender, now: clock },
    parsed.data,
  );
  return NextResponse.json(result, { status: 202 });
}
