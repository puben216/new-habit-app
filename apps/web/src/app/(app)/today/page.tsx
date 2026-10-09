import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { StateMessage } from "@/components/state-message";

export const metadata: Metadata = { title: "今日" };

/** 空の保護画面。今日の予定と記録は T-215 が実装する。 */
export default function TodayPage() {
  return (
    <>
      <PageHeader title="今日" />
      <StateMessage
        kind="empty"
        title="今日の予定はまだ表示できません"
        description="記録の画面は準備中です。"
      />
    </>
  );
}
