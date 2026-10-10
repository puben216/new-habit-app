import { getAdminHandlers } from "@/server/admin-container";

/**
 * `/api/v1/admin/` 配下の未定義 path。存在する管理 route と同じ応答(未認証 401、それ以外 404)にして、
 * route の有無から管理機能の構成を推測できないようにする。
 */
async function respond(request: Request): Promise<Response> {
  return (await getAdminHandlers()).notFound(request);
}

export const GET = respond;
export const POST = respond;
export const PUT = respond;
export const PATCH = respond;
export const DELETE = respond;
