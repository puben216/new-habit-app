import { getWeeklyReviewHandlers } from "@/server/weekly-review-container";

export async function GET(request: Request): Promise<Response> {
  const handlers = await getWeeklyReviewHandlers();
  return handlers.list(request);
}

export async function POST(request: Request): Promise<Response> {
  const handlers = await getWeeklyReviewHandlers();
  return handlers.create(request);
}
