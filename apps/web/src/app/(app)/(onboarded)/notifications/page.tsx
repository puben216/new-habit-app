import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { NotificationsView } from "@/features/notifications/notifications-view";

export const metadata: Metadata = { title: "通知" };

export default function NotificationsPage() {
  return (
    <>
      <PageHeader title="通知" description="リマインドメールの設定です。" />
      <NotificationsView supportedTimezones={Intl.supportedValuesOf("timeZone")} />
    </>
  );
}
