import { getUnsubscribeHandlers } from "@/server/unsubscribe-container";

export async function GET(request: Request): Promise<Response> {
  const handlers = await getUnsubscribeHandlers();
  return handlers.get(request);
}

export async function POST(request: Request): Promise<Response> {
  const handlers = await getUnsubscribeHandlers();
  return handlers.post(request);
}
