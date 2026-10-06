import { getDashboardHandlers } from "@/server/dashboard-container";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const handlers = await getDashboardHandlers();
  return handlers.get(request);
}
