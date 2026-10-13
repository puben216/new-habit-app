import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { RestorePanel } from "@/features/account/restore-panel";

export const metadata: Metadata = { title: "削除の取り消し" };

export default function RestoreAccountPage() {
  return (
    <>
      <PageHeader title="アカウントの削除が予約されています" />
      <RestorePanel />
    </>
  );
}
