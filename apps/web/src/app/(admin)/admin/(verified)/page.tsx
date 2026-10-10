import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { AdminHome } from "@/features/admin/admin-home";

export const metadata: Metadata = { title: "概要" };

export default function AdminHomePage() {
  return (
    <>
      <PageHeader
        title="管理"
        description="閲覧のみの画面です。表示するたびに監査ログへ記録されます。"
      />
      <AdminHome />
    </>
  );
}
