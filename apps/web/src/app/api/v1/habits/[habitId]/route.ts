import { getHabitHandlers } from "@/server/habit-container";

interface RouteContext {
  readonly params: Promise<{ habitId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getHabitHandlers();
  return handlers.get(request, await context.params);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getHabitHandlers();
  return handlers.update(request, await context.params);
}
