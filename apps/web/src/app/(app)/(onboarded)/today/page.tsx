import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { TodayView } from "@/features/today/today-view";

export const metadata: Metadata = { title: "今日" };

interface TodayPageProps {
  readonly searchParams: Promise<{ date?: string | string[] }>;
}

export default async function TodayPage({ searchParams }: TodayPageProps) {
  const { date } = await searchParams;

  return (
    <>
      <PageHeader title="今日" />
      <TodayView dateParam={Array.isArray(date) ? date[0] : date} />
    </>
  );
}
