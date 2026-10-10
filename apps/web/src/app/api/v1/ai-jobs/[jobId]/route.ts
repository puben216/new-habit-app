import { getAiJobHandlers } from "@/server/ai-job-container";

interface RouteContext {
  readonly params: Promise<{ jobId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getAiJobHandlers();
  return handlers.get(request, await context.params);
}
