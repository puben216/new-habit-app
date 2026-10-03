/**
 * Auth.js の session から actor user ID を取り出す(docs/specs/auth-adapter.md AUTH-009)。
 *
 * T-101 の `session` callback は、DB の sessions 行が有効なときだけ `session.user.id` を設定し、
 * 期限切れ・失効・改ざんでは `user` を持たせない。したがって `user.id` が空でない文字列で
 * ある場合にのみ認証済みとみなし、それ以外はすべて未認証(null)として扱う。
 */
export function actorUserIdFromSession(session: unknown): string | null {
  if (typeof session !== "object" || session === null) return null;
  const user = (session as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
