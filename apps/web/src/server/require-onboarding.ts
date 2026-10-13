import { redirect } from "next/navigation";

import { DEFAULT_NEXT_PATH } from "@/lib/auth/next-path";

import { getProfileForActor } from "./profile-container";
import { guardNotOnboarding, isOnboardingRequired } from "./onboarding-guard";
import { requireSession } from "./require-session";

export const ONBOARDING_PATH = "/onboarding";

/**
 * `(onboarded)` layout 用。未認証は login へ redirect し、認証済みならオンボーディングが未完了かを返す。
 * 未完了のときは、layout が子の代わりに閉じられないモーダルを表示する(PFS-001)。
 */
export async function isOnboardingRequiredForSession(): Promise<boolean> {
  const userId = await requireSession();
  return isOnboardingRequired({ getProfile: () => getProfileForActor(userId) });
}

/** `/onboarding` 用。完了済みなら `/today` へ redirect する。 */
export async function requireNotOnboarded(): Promise<void> {
  const userId = await requireSession();
  await guardNotOnboarding({
    getProfile: () => getProfileForActor(userId),
    redirect: () => redirect(DEFAULT_NEXT_PATH),
  });
}
