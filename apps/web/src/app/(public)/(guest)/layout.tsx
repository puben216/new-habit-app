import type { ReactNode } from "react";

import { redirectIfSignedIn } from "@/server/require-session";

// session に依存するため build 時に prerender しない。
export const dynamic = "force-dynamic";

/** 認証画面(login/signup/password-reset 要求)。認証済みなら `/today` へ redirect する(AUI-009)。 */
export default async function GuestLayout({ children }: { children: ReactNode }) {
  await redirectIfSignedIn();
  return children;
}
