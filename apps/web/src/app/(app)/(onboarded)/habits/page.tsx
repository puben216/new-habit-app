import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { HabitList } from "@/features/habits/habit-list";

export const metadata: Metadata = { title: "習慣" };

interface HabitsPageProps {
  readonly searchParams: Promise<{ status?: string | string[] }>;
}

export default async function HabitsPage({ searchParams }: HabitsPageProps) {
  const { status } = await searchParams;

  return (
    <>
      <PageHeader title="習慣" />
      <p>
        <Link href="/habits/new">新しい習慣を作る</Link>
      </p>
      <HabitList status={status === "archived" ? "archived" : "active"} />
    </>
  );
}
