import { getHabitHandlers } from "@/server/habit-container";

interface RouteContext {
  readonly params: Promise<{ habitId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getHabitHandlers();
  return handlers.archive(request, await context.params);
}
