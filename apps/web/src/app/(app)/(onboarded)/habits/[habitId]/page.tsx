import type { Metadata } from "next";

import { HabitDetail } from "@/features/habits/habit-detail";

export const metadata: Metadata = { title: "習慣の詳細" };

interface HabitPageProps {
  readonly params: Promise<{ habitId: string }>;
}

export default async function HabitPage({ params }: HabitPageProps) {
  const { habitId } = await params;
  return <HabitDetail habitId={habitId} />;
}
