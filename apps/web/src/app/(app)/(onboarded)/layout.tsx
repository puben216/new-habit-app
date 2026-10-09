import type { ReactNode } from "react";

import { requireOnboarded } from "@/server/require-onboarding";

/** オンボーディング完了が必要な画面。未完了なら `/onboarding` へ redirect する(PFS-001)。 */
export default async function OnboardedLayout({ children }: { children: ReactNode }) {
  await requireOnboarded();
  return children;
}
