import { getDataExportHandlers } from "@/server/data-export-container";

// session(cookie)に依存する応答のため、静的化・キャッシュを行わない。
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ exportId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const handlers = await getDataExportHandlers();
  return handlers.download(request, await context.params);
}
