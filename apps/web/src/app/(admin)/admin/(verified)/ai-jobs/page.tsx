import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { AiJobFailures } from "@/features/admin/ai-job-failures";
import { parseFailureStatus } from "@/lib/admin/failure-status";

export const metadata: Metadata = { title: "AI ジョブの失敗" };

interface AiJobsPageProps {
  readonly searchParams: Promise<{ status?: string | string[] }>;
}

export default async function AdminAiJobsPage({ searchParams }: AiJobsPageProps) {
  const { status } = await searchParams;

  return (
    <>
      <PageHeader
        title="AI ジョブの失敗"
        description="失敗またはフォールバックになったジョブを新しい順に表示します。入出力の本文は表示されません。"
      />
      <AiJobFailures status={parseFailureStatus("ai", status)} />
    </>
  );
}
