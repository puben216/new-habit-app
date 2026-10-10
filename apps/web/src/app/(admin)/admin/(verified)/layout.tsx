import type { ReactNode } from "react";

import { requireAdminArea } from "@/server/admin-access";

/** MFA 検証済みの Admin だけが見る画面。未検証/期限切れは `/admin/mfa?next=…` へ redirect する(ADS-001)。 */
export default async function VerifiedAdminLayout({ children }: { children: ReactNode }) {
  await requireAdminArea("verified");
  return children;
}
