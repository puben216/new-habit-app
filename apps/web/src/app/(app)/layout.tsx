import type { ReactNode } from "react";

import { AppNav } from "@/components/app-nav";
import { MainContent } from "@/components/main-content";
import { SiteHeader } from "@/components/site-header";
import { requireSession } from "@/server/require-session";

// session に依存するため build 時に prerender しない(build 時は env と DB を使えない)。
export const dynamic = "force-dynamic";

/**
 * 認証が必要な画面の共通 layout(ADR-010、docs/specs/web-ui-foundation.md WUI-002)。
 * 未認証なら子を描画せず `/login` へ redirect する。保護は UX のためで、データの保護は API の認可が担う。
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSession();

  return (
    <>
      <SiteHeader>
        <AppNav />
      </SiteHeader>
      <MainContent>{children}</MainContent>
    </>
  );
}
