import { getAccountDeletionHandlers } from "@/server/account-deletion-container";

// session(cookie)に依存する応答のため、静的化・キャッシュを行わない。
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const handlers = await getAccountDeletionHandlers();
  return handlers.status(request);
}
