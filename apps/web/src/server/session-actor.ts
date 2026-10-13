import { isAccountStatus, type AccountStatus } from "@habit-app/domain";

/**
 * Auth.js の session から actor user ID を取り出す(docs/specs/auth-adapter.md AUTH-009)。
 *
 * T-101 の `session` callback は、DB の sessions 行が有効なときだけ `session.user.id` を設定し、
 * 期限切れ・失効・改ざんでは `user` を持たせない。したがって `user.id` が空でない文字列で
 * ある場合にのみ認証済みとみなし、それ以外はすべて未認証(null)として扱う。
 */
export function actorUserIdFromSession(session: unknown): string | null {
  const userId = userIdFromSession(session);
  if (userId === null) return null;
  // 削除予約中の session は、Member 向けの全 API で actor を持たない(= 401)。この 1 箇所に集約し、
  // 新しい API も自動的に遮断される(docs/specs/account-deletion.md ACD-INV-003)。
  return (session as { accountStatus?: unknown }).accountStatus === "deletion_pending"
    ? null
    : userId;
}

export interface AccountSessionInfo {
  readonly userId: string;
  /** DB の `users.status`(session callback が毎回 DB から取得して載せる)。 */
  readonly status: AccountStatus;
}

function userIdFromSession(session: unknown): string | null {
  if (typeof session !== "object" || session === null) return null;
  const user = (session as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * 削除予約中の session でも user ID を取り出す(アカウントの状態の確認と取り消しだけが使う。ACD-003)。
 * 有効な session で、状態が未知・欠落の場合は認証済みとして扱わない(fail closed)。
 */
export function accountSessionFromAuth(session: unknown): AccountSessionInfo | null {
  const userId = userIdFromSession(session);
  if (userId === null) return null;
  const status = (session as { accountStatus?: unknown }).accountStatus;
  return isAccountStatus(status) ? { userId, status } : null;
}

export interface AdminSessionInfo {
  readonly userId: string;
  /** DB の session 行の識別子(MFA 検証時刻の更新対象)。 */
  readonly sessionId: string;
  readonly mfaVerifiedAt: Date | null;
}

/**
 * Auth.js の session から、管理機能が使う情報(actor、session 行、MFA 検証時刻)を取り出す(T-403)。
 * `user.id` が無い(未認証・失効)場合や `sessionId` が無い場合は `null`。
 * 管理者かどうかは session から判断しない(毎回 DB で判定する。ADM-INV-001)。
 */
export function adminSessionFromAuth(session: unknown): AdminSessionInfo | null {
  const userId = actorUserIdFromSession(session);
  if (userId === null) return null;
  const { sessionId, mfaVerifiedAt } = session as { sessionId?: unknown; mfaVerifiedAt?: unknown };
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  let verifiedAt: Date | null = null;
  if (typeof mfaVerifiedAt === "string") {
    const parsed = new Date(mfaVerifiedAt);
    verifiedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return { userId, sessionId, mfaVerifiedAt: verifiedAt };
}
