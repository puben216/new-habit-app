import { getEntryHandlers } from "@/server/entry-container";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const handlers = await getEntryHandlers();
  return handlers.today(request);
}
