import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { MfaForm } from "@/features/admin/mfa-form";
import { sanitizeAdminNextPath } from "@/lib/admin/next-path";
import { requireAdminArea } from "@/server/admin-access";

export const metadata: Metadata = { title: "確認コードの入力" };

interface MfaPageProps {
  readonly searchParams: Promise<{ next?: string | string[] }>;
}

export default async function AdminMfaPage({ searchParams }: MfaPageProps) {
  // 検証済みなら入力不要。`next` を読めるのは layout の redirect 先として path に載っているため。
  await requireAdminArea("mfa");
  const { next } = await searchParams;

  return (
    <>
      <PageHeader
        title="確認コードの入力"
        description="管理機能を使うには、認証アプリのコードまたはリカバリーコードの確認が必要です。"
      />
      <MfaForm nextPath={sanitizeAdminNextPath(next)} />
    </>
  );
}
