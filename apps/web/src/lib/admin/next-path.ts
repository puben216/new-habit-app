import { parseNextPath } from "@/lib/auth/next-path";

/**
 * MFA 検証後の遷移先(`next`)の検証(docs/specs/admin-screens.md ADS-001、ADS-INV-001)。
 *
 * 既存の `parseNextPath`(同一 origin の path だけを通す許可リスト)を通した上で、`/admin` 配下に絞る。
 * `/admin/mfa` 自身は循環するので除き、それ以外はすべて `/admin` にする。
 */
export const ADMIN_HOME_PATH = "/admin";
export const ADMIN_MFA_PATH = "/admin/mfa";

function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_HOME_PATH || pathname.startsWith(`${ADMIN_HOME_PATH}/`);
}

export function sanitizeAdminNextPath(raw: string | readonly string[] | undefined): string {
  const parsed = parseNextPath(raw);
  if (parsed === null) return ADMIN_HOME_PATH;

  const queryStart = parsed.indexOf("?");
  const pathname = queryStart === -1 ? parsed : parsed.slice(0, queryStart);
  if (!isAdminPath(pathname)) return ADMIN_HOME_PATH;
  if (pathname === ADMIN_MFA_PATH || pathname.startsWith(`${ADMIN_MFA_PATH}/`)) {
    return ADMIN_HOME_PATH;
  }
  return parsed;
}

/** 検証画面への redirect 先。`next` は検証を通ったものだけを載せる。 */
export function buildAdminMfaPath(next: string | undefined): string {
  const safe = sanitizeAdminNextPath(next);
  return safe === ADMIN_HOME_PATH
    ? ADMIN_MFA_PATH
    : `${ADMIN_MFA_PATH}?next=${encodeURIComponent(safe)}`;
}
