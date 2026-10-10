import { getEntryHandlers } from "@/server/entry-container";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ date: string }> },
): Promise<Response> {
  const handlers = await getEntryHandlers();
  return handlers.scheduleOnDate(request, await context.params);
}
