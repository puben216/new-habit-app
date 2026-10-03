import { getProfileHandlers } from "@/server/profile-container";

// session(cookie)に依存する応答のため、静的化・キャッシュを行わない。
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { GET: handleGet } = await getProfileHandlers();
  return handleGet(request);
}

export async function PATCH(request: Request): Promise<Response> {
  const { PATCH: handlePatch } = await getProfileHandlers();
  return handlePatch(request);
}
