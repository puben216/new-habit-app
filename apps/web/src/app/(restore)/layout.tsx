import type { ReactNode } from "react";

import { MainContent } from "@/components/main-content";
import { SiteHeader } from "@/components/site-header";
import { requireDeletionPending } from "@/server/require-session";

// session に依存するため build 時に prerender しない。
export const dynamic = "force-dynamic";

/**
 * 削除予約中の利用者が着く画面の共通 layout(docs/specs/account-deletion.md ACD-007)。
 * 取り消しとログアウトだけができるため、Member 向けのナビゲーションは置かない。
 * 未認証は login へ、削除予約中でなければ通常の画面へ redirect する。
 */
export default async function RestoreLayout({ children }: { children: ReactNode }) {
  await requireDeletionPending();

  return (
    <>
      <SiteHeader />
      <MainContent>{children}</MainContent>
    </>
  );
}
