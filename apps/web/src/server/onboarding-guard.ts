import { hasCompletedOnboarding } from "@habit-app/application";

/**
 * オンボーディングの誘導(docs/specs/profile-screens.md PFS-001)。判定自体は Application の
 * `hasCompletedOnboarding` に委ね、ここでは redirect の要否だけを決める。
 */
export interface OnboardingGuardDeps {
  readonly getProfile: () => Promise<{ readonly displayName: string | null }>;
  readonly redirect: () => never;
}

/**
 * `(onboarded)` 配下用。オンボーディングが未完了かを返す。未完了のときの表示(閉じられないモーダル)は
 * 呼び出し側が決める(PFS-001)。判定自体は Application の `hasCompletedOnboarding` に委ねる。
 */
export async function isOnboardingRequired(deps: {
  readonly getProfile: OnboardingGuardDeps["getProfile"];
}): Promise<boolean> {
  return !hasCompletedOnboarding(await deps.getProfile());
}

/** `/onboarding` 用。完了済みなら保護画面へ redirect する。 */
export async function guardNotOnboarding(deps: OnboardingGuardDeps): Promise<void> {
  if (hasCompletedOnboarding(await deps.getProfile())) deps.redirect();
}
