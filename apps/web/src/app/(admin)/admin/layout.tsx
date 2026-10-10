import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AdminNav } from "@/components/admin-nav";
import { HeaderActions } from "@/components/header-actions";
import { LogoutButton } from "@/components/logout-button";
import { MainContent } from "@/components/main-content";
import { SiteHeader } from "@/components/site-header";
import { requireAdminArea } from "@/server/admin-access";

// session と DB の判定に依存するため build 時に prerender しない。
export const dynamic = "force-dynamic";

// 管理画面は検索エンジンに載せない(docs/specs/admin-screens.md ADS-008)。
export const metadata: Metadata = {
  title: { default: "管理", template: "%s | 管理" },
  robots: { index: false, follow: false },
};

/**
 * 管理画面の共通 layout(ADS-001)。未認証は login へ、Admin でなければ 404(通常の not-found と同じ表示)。
 * MFA の要否は子の layout/page が判定する。保護は UX のためで、データの保護は API が担う。
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminArea("shell");

  return (
    <>
      <SiteHeader>
        <HeaderActions>
          <AdminNav />
          <LogoutButton />
        </HeaderActions>
      </SiteHeader>
      <MainContent>{children}</MainContent>
    </>
  );
}
