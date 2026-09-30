import type { NextRequest } from "next/server";

import { getAuthContainer } from "@/server/auth-container";

export async function GET(request: NextRequest): Promise<Response> {
  const { authHandlers } = await getAuthContainer();
  return authHandlers.GET(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  const { authHandlers } = await getAuthContainer();
  return authHandlers.POST(request);
}
