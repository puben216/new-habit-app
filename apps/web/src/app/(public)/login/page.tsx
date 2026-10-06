import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { StateMessage } from "@/components/state-message";

export const metadata: Metadata = { title: "ログイン" };

/** 暫定表示。ログイン画面は T-212 が置き換える。 */
export default function LoginPage() {
  return (
    <>
      <PageHeader title="ログイン" />
      <StateMessage
        kind="empty"
        title="ログイン画面は準備中です"
        description="認証画面の公開までお待ちください。"
      />
    </>
  );
}
