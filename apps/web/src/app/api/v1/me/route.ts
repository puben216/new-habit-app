import { getAccountDeletionHandlers } from "@/server/account-deletion-container";
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

/** アカウント削除の要求(再認証あり。docs/specs/account-deletion.md ACD-001/002)。 */
export async function DELETE(request: Request): Promise<Response> {
  const handlers = await getAccountDeletionHandlers();
  return handlers.request(request);
}
