import { getEntryHandlers } from "@/server/entry-container";

interface RouteContext {
  readonly params: Promise<{ habitId: string; date: string }>;
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getEntryHandlers();
  return handlers.upsert(request, await context.params);
}
