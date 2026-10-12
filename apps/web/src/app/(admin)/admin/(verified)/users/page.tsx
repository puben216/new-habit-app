import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { UserSearch } from "@/features/admin/user-search";

export const metadata: Metadata = { title: "ユーザー検索" };

export default function AdminUsersPage() {
  return (
    <>
      <PageHeader
        title="ユーザー検索"
        description="メールアドレスの完全一致で検索します。検索した事実は監査ログに記録されます(メールアドレスは記録されません)。"
      />
      <UserSearch />
    </>
  );
}
