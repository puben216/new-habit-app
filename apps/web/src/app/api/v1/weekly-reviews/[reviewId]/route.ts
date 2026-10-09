import { getWeeklyReviewHandlers } from "@/server/weekly-review-container";

interface RouteContext {
  readonly params: Promise<{ reviewId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getWeeklyReviewHandlers();
  return handlers.get(request, await context.params);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getWeeklyReviewHandlers();
  return handlers.update(request, await context.params);
}
