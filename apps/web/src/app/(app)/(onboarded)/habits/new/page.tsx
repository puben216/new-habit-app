import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { HabitCreateForm } from "@/features/habits/habit-create-form";

export const metadata: Metadata = { title: "習慣を作る" };

export default function NewHabitPage() {
  return (
    <>
      <PageHeader title="習慣を作る" />
      <HabitCreateForm />
    </>
  );
}
