import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { UserOverview } from "@/features/admin/user-overview";

export const metadata: Metadata = { title: "ユーザー概要" };

interface UserPageProps {
  readonly params: Promise<{ publicId: string }>;
}

export default async function AdminUserPage({ params }: UserPageProps) {
  const { publicId } = await params;

  return (
    <>
      <PageHeader title="ユーザー概要" description="表示するたびに監査ログへ記録されます。" />
      <UserOverview publicId={publicId} />
    </>
  );
}
