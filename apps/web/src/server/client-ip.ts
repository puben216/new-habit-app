/**
 * ALB 背後では、ALB が client の IP を `X-Forwarded-For` の末尾に追加する。client が先頭側を
 * 偽装できるため、末尾(自分たちの proxy が付けた値)を使う。信頼する proxy 段数は共通基盤(T-501)で確定する。
 * 監査ログには不可逆化した値だけを残す。
 */
export function clientIpFrom(request: Request): string | null {
  const header = request.headers.get("x-forwarded-for");
  if (header === null) return null;
  const last = header.split(",").pop()?.trim() ?? "";
  return last.length > 0 && last.length <= 45 ? last : null;
}
