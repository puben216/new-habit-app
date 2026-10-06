import type { ReactNode } from "react";

import { MainContent } from "@/components/main-content";
import { SiteHeader } from "@/components/site-header";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <MainContent>{children}</MainContent>
    </>
  );
}
