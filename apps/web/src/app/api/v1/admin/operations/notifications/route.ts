import { getAdminHandlers } from "@/server/admin-container";

export async function GET(request: Request): Promise<Response> {
  return (await getAdminHandlers()).listNotificationFailures(request);
}
