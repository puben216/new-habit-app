import { verifyEmail } from "@habit-app/application";
import { verifyEmailRequestSchema } from "@habit-app/contracts";
import { NextResponse } from "next/server";

import { getAuthContainer } from "@/server/auth-container";
import { invalidOrExpiredTokenResponse, parseJsonBody } from "@/server/http";

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, verifyEmailRequestSchema);
  if (!parsed.ok) return parsed.response;

  const { authRepository, tokenGenerator, clock } = await getAuthContainer();

  const result = await verifyEmail({ authRepository, tokenGenerator, now: clock }, parsed.data);
  if (!result.verified) return invalidOrExpiredTokenResponse();

  return NextResponse.json({ verified: true }, { status: 200 });
}
