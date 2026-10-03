import { getHabitHandlers } from "@/server/habit-container";

export async function GET(request: Request): Promise<Response> {
  const handlers = await getHabitHandlers();
  return handlers.list(request);
}

export async function POST(request: Request): Promise<Response> {
  const handlers = await getHabitHandlers();
  return handlers.create(request);
}
