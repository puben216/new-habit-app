/**
 * token(email verification / password reset)が期限切れかどうかを判定する。
 * expiresAt と同時刻の場合も期限切れとして扱う(docs/specs/auth-adapter.md AUTH-003/AUTH-008)。
 */
export function isTokenExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}
