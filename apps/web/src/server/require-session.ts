import { redirect } from "next/navigation";

import { getAuthContainer } from "./auth-container";
import { actorUserIdFromSession } from "./session-actor";
import { guardSession } from "./session-guard";

export const LOGIN_PATH = "/login";

/**
 * Server Component 用。DB session を検証し、未認証なら `/login` へ redirect する。
 * 有効な session の user ID を返す(Cookie の存在だけでは通さない。ADR-010)。
 */
export function requireSession(): Promise<string> {
  return guardSession({
    getActorUserId: async () => {
      const { auth } = await getAuthContainer();
      return actorUserIdFromSession(await auth());
    },
    redirectToLogin: () => redirect(LOGIN_PATH),
  });
}
