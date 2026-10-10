import { getAdminHandlers } from "@/server/admin-container";

interface RouteContext {
  readonly params: Promise<{ publicId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return (await getAdminHandlers()).getUser(request, await context.params);
}
