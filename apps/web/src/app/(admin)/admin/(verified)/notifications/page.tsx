import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { NotificationFailures } from "@/features/admin/notification-failures";
import { parseFailureStatus } from "@/lib/admin/failure-status";

export const metadata: Metadata = { title: "通知配送の失敗" };

interface NotificationsPageProps {
  readonly searchParams: Promise<{ status?: string | string[] }>;
}

export default async function AdminNotificationsPage({ searchParams }: NotificationsPageProps) {
  const { status } = await searchParams;

  return (
    <>
      <PageHeader
        title="通知配送の失敗"
        description="失敗・期限切れ・配信停止になった通知を新しい順に表示します。"
      />
      <NotificationFailures status={parseFailureStatus("notification", status)} />
    </>
  );
}
