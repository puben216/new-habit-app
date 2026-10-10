import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { DashboardView } from "@/features/dashboard/dashboard-view";

export const metadata: Metadata = { title: "ダッシュボード" };

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="ダッシュボード" description="直近の記録の振り返りです。" />
      <DashboardView />
    </>
  );
}
