/**
 * ログイン後の遷移先(`next`)の検証(docs/specs/auth-screens.md AUI-007、AUI-INV-003)。
 *
 * 許可リスト方式: `/` で始まる同一 origin の path だけを通し、それ以外はすべて既定の `/today` にする。
 * query の値は URL の一部であり、攻撃者が任意に指定できる。
 */
export const DEFAULT_NEXT_PATH = "/today";
export const SESSION_EXPIRED_REASON = "session_expired";

const MAX_NEXT_LENGTH = 2048;
const PLACEHOLDER_ORIGIN = "http://next-path.invalid";

/** 遷移先にしない path(API と認証画面自身。ログイン後に認証画面へ戻る循環を避ける)。 */
const BLOCKED_PREFIXES = ["/api", "/login", "/signup", "/verify-email", "/password-reset"];

// 空白・制御文字・バックスロッシュ。URL パーサーが除去/変換して `//host` に化けるのを防ぐ。
const FORBIDDEN_CHARACTERS = /[\\\s\u0000-\u001f\u007f]/;

function isBlocked(pathname: string): boolean {
  return BLOCKED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** 安全な `next` なら正規化した path+query を、そうでなければ `null` を返す。 */
export function parseNextPath(raw: string | readonly string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_NEXT_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (FORBIDDEN_CHARACTERS.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  if (isBlocked(url.pathname)) return null;

  // `/.//evil.example` のように正規化後に `//` で始まる path は protocol-relative URL になる。
  const normalized = `${url.pathname}${url.search}`;
  if (normalized.startsWith("//")) return null;
  return normalized;
}

export function sanitizeNextPath(raw: string | readonly string[] | undefined): string {
  return parseNextPath(raw) ?? DEFAULT_NEXT_PATH;
}

export interface LoginPathOptions {
  readonly next?: string | undefined;
  readonly reason?: typeof SESSION_EXPIRED_REASON | undefined;
}

/** `/login` への redirect 先を組み立てる。`next` は検証を通ったものだけを載せる。 */
export function buildLoginPath(options: LoginPathOptions = {}): string {
  const params = new URLSearchParams();
  const next = parseNextPath(options.next);
  if (next !== null) params.set("next", next);
  if (options.reason === SESSION_EXPIRED_REASON) params.set("reason", SESSION_EXPIRED_REASON);
  const query = params.toString();
  return query === "" ? "/login" : `/login?${query}`;
}
