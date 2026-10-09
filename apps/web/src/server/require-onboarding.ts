import { redirect } from "next/navigation";

import { DEFAULT_NEXT_PATH } from "@/lib/auth/next-path";

import { getProfileForActor } from "./profile-container";
import { guardNotOnboarding, guardOnboarded } from "./onboarding-guard";
import { requireSession } from "./require-session";

export const ONBOARDING_PATH = "/onboarding";

/** `(onboarded)` layout 用。未認証は login へ、未完了は `/onboarding` へ redirect する。 */
export async function requireOnboarded(): Promise<void> {
  const userId = await requireSession();
  await guardOnboarded({
    getProfile: () => getProfileForActor(userId),
    redirect: () => redirect(ONBOARDING_PATH),
  });
}

/** `/onboarding` 用。完了済みなら `/today` へ redirect する。 */
export async function requireNotOnboarded(): Promise<void> {
  const userId = await requireSession();
  await guardNotOnboarding({
    getProfile: () => getProfileForActor(userId),
    redirect: () => redirect(DEFAULT_NEXT_PATH),
  });
}
