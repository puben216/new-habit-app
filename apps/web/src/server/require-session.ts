import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { buildLoginPath, DEFAULT_NEXT_PATH } from "@/lib/auth/next-path";

import { getAuthContainer } from "./auth-container";
import { PATHNAME_HEADER } from "./pathname-header";
import { actorUserIdFromSession } from "./session-actor";
import { guardGuest, guardSession } from "./session-guard";

async function currentActorUserId(): Promise<string | null> {
  const { auth } = await getAuthContainer();
  return actorUserIdFromSession(await auth());
}

/**
 * Server Component 用。DB session を検証し、未認証なら `/login?next=…` へ redirect する。
 * 有効な session の user ID を返す(Cookie の存在だけでは通さない。ADR-010)。
 * `next` は proxy が付与した現在の path で、`buildLoginPath` が検証してから載せる。
 */
export async function requireSession(): Promise<string> {
  const loginPath = buildLoginPath({
    next: (await headers()).get(PATHNAME_HEADER) ?? undefined,
  });
  return guardSession({
    getActorUserId: currentActorUserId,
    redirectToLogin: () => redirect(loginPath),
  });
}

/** 認証画面用。認証済みなら保護画面(`/today`)へ redirect する。 */
export function redirectIfSignedIn(): Promise<void> {
  return guardGuest({
    getActorUserId: currentActorUserId,
    redirectToApp: () => redirect(DEFAULT_NEXT_PATH),
  });
}
