import { getAdminHandlers } from "@/server/admin-container";

export async function POST(request: Request): Promise<Response> {
  return (await getAdminHandlers()).verifyMfa(request);
}
