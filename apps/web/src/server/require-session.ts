import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { buildLoginPath, DEFAULT_NEXT_PATH } from "@/lib/auth/next-path";

import { getAuthContainer } from "./auth-container";
import { PATHNAME_HEADER } from "./pathname-header";
import { accountSessionFromAuth, actorUserIdFromSession } from "./session-actor";
import { decideRestoreGuard, guardGuest, guardSession } from "./session-guard";

/** 削除予約中の利用者が着く画面(取り消し・ログアウトだけができる)。 */
export const ACCOUNT_RESTORE_PATH = "/account/restore";

async function currentActorUserId(): Promise<string | null> {
  const { auth } = await getAuthContainer();
  return actorUserIdFromSession(await auth());
}

async function currentAccountSession() {
  const { auth } = await getAuthContainer();
  return accountSessionFromAuth(await auth());
}

/** 削除予約中の session なら、取り消し画面へ移す(Member 向けの画面は表示しない。ACD-003)。 */
async function redirectIfDeletionPending(): Promise<void> {
  if ((await currentAccountSession())?.status === "deletion_pending") {
    redirect(ACCOUNT_RESTORE_PATH);
  }
}

/**
 * Server Component 用。DB session を検証し、未認証なら `/login?next=…` へ redirect する。
 * 有効な session の user ID を返す(Cookie の存在だけでは通さない。ADR-010)。
 * `next` は proxy が付与した現在の path で、`buildLoginPath` が検証してから載せる。
 */
export async function requireSession(): Promise<string> {
  await redirectIfDeletionPending();
  const loginPath = buildLoginPath({
    next: (await headers()).get(PATHNAME_HEADER) ?? undefined,
  });
  return guardSession({
    getActorUserId: currentActorUserId,
    redirectToLogin: () => redirect(loginPath),
  });
}

/** 認証画面用。認証済みなら保護画面(`/today`)へ redirect する。 */
export async function redirectIfSignedIn(): Promise<void> {
  await redirectIfDeletionPending();
  return guardGuest({
    getActorUserId: currentActorUserId,
    redirectToApp: () => redirect(DEFAULT_NEXT_PATH),
  });
}

/**
 * `/account/restore` 用。削除予約中の session だけが表示できる。未認証は login へ、
 * 削除予約中でなければ通常の画面(`/today`)へ redirect する。
 */
export async function requireDeletionPending(): Promise<void> {
  const account = await currentAccountSession();
  const outcome = decideRestoreGuard(account?.status ?? null);
  switch (outcome) {
    case "render":
      return;
    case "login":
      return redirect(buildLoginPath({ next: ACCOUNT_RESTORE_PATH }));
    case "app":
      return redirect(DEFAULT_NEXT_PATH);
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}
