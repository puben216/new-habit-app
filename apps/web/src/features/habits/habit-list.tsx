"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/button";
import { StateMessage } from "@/components/state-message";
import { listHabits, habitsQueryKey, type HabitStatusFilter } from "@/lib/habits/habits-api";
import { kindLabel, summarizeDays } from "@/lib/habits/labels";

import styles from "./habit-list.module.css";

const TABS: readonly { status: HabitStatusFilter; label: string; href: string }[] = [
  { status: "active", label: "進行中", href: "/habits" },
  { status: "archived", label: "アーカイブ済み", href: "/habits?status=archived" },
];

export function HabitList({ status }: { status: HabitStatusFilter }) {
  const query = useInfiniteQuery({
    queryKey: habitsQueryKey(status),
    queryFn: ({ pageParam, signal }) => listHabits(status, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <nav aria-label="表示の切り替え" className={styles["tabs"]}>
        {TABS.map((tab) => (
          <Link
            key={tab.status}
            href={tab.href}
            className={styles["tab"]}
            aria-current={tab.status === status ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {query.isPending ? <StateMessage kind="loading" title="読み込んでいます" /> : null}
      {query.isError ? (
        <StateMessage
          kind="error"
          title="習慣を読み込めませんでした"
          description="時間をおいてもう一度お試しください。"
          action={<Button onClick={() => void query.refetch()}>もう一度試す</Button>}
        />
      ) : null}
      {query.isSuccess && items.length === 0 ? (
        <StateMessage
          kind="empty"
          title={
            status === "active"
              ? "進行中の習慣はまだありません"
              : "アーカイブ済みの習慣はありません"
          }
          action={status === "active" ? <Link href="/habits/new">習慣を作る</Link> : undefined}
        />
      ) : null}
      {items.length > 0 ? (
        <ul className={styles["list"]}>
          {items.map((habit) => {
            const schedule =
              habit.scheduleVersions.find((version) => version.effectiveTo === null) ??
              habit.scheduleVersions[habit.scheduleVersions.length - 1];
            return (
              <li key={habit.id} className={styles["item"]}>
                <Link href={`/habits/${habit.id}`} className={styles["name"]}>
                  {habit.name}
                </Link>
                <p className={styles["meta"]}>
                  {kindLabel(habit.kind)}
                  {schedule === undefined ? "" : ` / ${summarizeDays(schedule.daysOfWeek)}`}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "読み込んでいます" : "さらに表示"}
        </Button>
      ) : null}
    </>
  );
}
