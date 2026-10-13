import { getDataExportHandlers } from "@/server/data-export-container";

// session(cookie)に依存する応答のため、静的化・キャッシュを行わない。
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const handlers = await getDataExportHandlers();
  return handlers.list(request);
}

export async function POST(request: Request): Promise<Response> {
  const handlers = await getDataExportHandlers();
  return handlers.create(request);
}
