/**
 * 保護画面のガード(docs/specs/web-ui-foundation.md WUI-002)。
 *
 * 未認証(actor ID が取れない)なら redirect を呼び、子の描画へ進ませない。redirect は
 * 例外で制御を戻さない(`never`)前提のため、戻り値の型は認証済みの user ID だけになる。
 */
export interface SessionGuardDeps {
  readonly getActorUserId: () => Promise<string | null>;
  readonly redirectToLogin: () => never;
}

export async function guardSession(deps: SessionGuardDeps): Promise<string> {
  const actorUserId = await deps.getActorUserId();
  if (actorUserId === null) return deps.redirectToLogin();
  return actorUserId;
}

export interface GuestGuardDeps {
  readonly getActorUserId: () => Promise<string | null>;
  readonly redirectToApp: () => never;
}

/**
 * 認証画面(login/signup/password-reset 要求)のガード(docs/specs/auth-screens.md AUI-009)。
 * 認証済みなら保護画面へ redirect し、未認証なら何もしない。
 */
export async function guardGuest(deps: GuestGuardDeps): Promise<void> {
  const actorUserId = await deps.getActorUserId();
  if (actorUserId !== null) deps.redirectToApp();
}
