import { getCheckInHandlers } from "@/server/check-in-container";

interface RouteContext {
  readonly params: Promise<{ date: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getCheckInHandlers();
  return handlers.get(request, await context.params);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getCheckInHandlers();
  return handlers.upsert(request, await context.params);
}
