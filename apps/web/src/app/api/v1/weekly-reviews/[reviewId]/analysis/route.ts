import { getAiJobHandlers } from "@/server/ai-job-container";

interface RouteContext {
  readonly params: Promise<{ reviewId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getAiJobHandlers();
  return handlers.requestAnalysis(request, await context.params);
}
