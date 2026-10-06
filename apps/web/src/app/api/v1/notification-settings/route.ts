import { getNotificationSettingsHandlers } from "@/server/notification-settings-container";

export async function GET(request: Request): Promise<Response> {
  const handlers = await getNotificationSettingsHandlers();
  return handlers.get(request);
}

export async function PUT(request: Request): Promise<Response> {
  const handlers = await getNotificationSettingsHandlers();
  return handlers.upsert(request);
}
