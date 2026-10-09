import { hasCompletedOnboarding } from "@habit-app/application";

/**
 * オンボーディングの誘導(docs/specs/profile-screens.md PFS-001)。判定自体は Application の
 * `hasCompletedOnboarding` に委ね、ここでは redirect の要否だけを決める。
 */
export interface OnboardingGuardDeps {
  readonly getProfile: () => Promise<{ readonly displayName: string | null }>;
  readonly redirect: () => never;
}

/** `(onboarded)` 配下用。未完了なら `/onboarding` へ redirect する。 */
export async function guardOnboarded(deps: OnboardingGuardDeps): Promise<void> {
  if (!hasCompletedOnboarding(await deps.getProfile())) deps.redirect();
}

/** `/onboarding` 用。完了済みなら保護画面へ redirect する。 */
export async function guardNotOnboarding(deps: OnboardingGuardDeps): Promise<void> {
  if (hasCompletedOnboarding(await deps.getProfile())) deps.redirect();
}
