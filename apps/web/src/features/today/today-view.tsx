"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/button";
import { StateMessage } from "@/components/state-message";
import { buildDateOptions, parseSelectedDate } from "@/lib/today/dates";
import { getSchedule, scheduleKey } from "@/lib/today/today-api";

import { CheckInForm } from "./check-in-form";
import { HabitRecordCard } from "./habit-record-card";
import styles from "./today-view.module.css";

export function TodayView({ dateParam }: { dateParam: string | undefined }) {
  // 今日の予定は常に取得する。応答の date / earliestDate が日付選択の基準になる。
  const todayQuery = useQuery({
    queryKey: scheduleKey("today"),
    queryFn: ({ signal }) => getSchedule("today", signal),
  });

  const today = todayQuery.data?.date;
  const options =
    todayQuery.data === undefined
      ? []
      : buildDateOptions(todayQuery.data.date, todayQuery.data.earliestDate);
  const selected = today === undefined ? undefined : parseSelectedDate(dateParam, options, today);

  const dateQuery = useQuery({
    queryKey: scheduleKey(selected ?? "pending"),
    queryFn: ({ signal }) => getSchedule(selected ?? "today", signal),
    enabled: selected !== undefined && selected !== today,
  });

  if (todayQuery.isPending) return <StateMessage kind="loading" title="読み込んでいます" />;
  if (todayQuery.isError || today === undefined || selected === undefined) {
    return (
      <StateMessage
        kind="error"
        title="予定を読み込めませんでした"
        description="時間をおいてもう一度お試しください。"
        action={<Button onClick={() => void todayQuery.refetch()}>もう一度試す</Button>}
      />
    );
  }

  const schedule = selected === today ? todayQuery.data : dateQuery.data;

  return (
    <>
      <nav aria-label="記録する日" className={styles["dates"]}>
        {options.map((option) => (
          <Link
            key={option.date}
            href={option.date === today ? "/today" : `/today?date=${option.date}`}
            className={styles["date"]}
            aria-current={option.date === selected ? "date" : undefined}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      <section aria-labelledby="records-heading">
        <h2 id="records-heading">習慣の記録</h2>
        {schedule === undefined && dateQuery.isError ? (
          <StateMessage
            kind="error"
            title="予定を読み込めませんでした"
            action={<Button onClick={() => void dateQuery.refetch()}>もう一度試す</Button>}
          />
        ) : schedule === undefined ? (
          <StateMessage kind="loading" title="読み込んでいます" />
        ) : schedule.items.length === 0 ? (
          <StateMessage
            kind="empty"
            title="この日に予定された習慣はありません"
            action={<Link href="/habits">習慣を管理する</Link>}
          />
        ) : (
          <ul className={styles["list"]}>
            {schedule.items.map((item) => (
              <HabitRecordCard key={`${selected}:${item.habit.id}`} item={item} date={selected} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="check-in-heading">
        <h2 id="check-in-heading">デイリーチェックイン</h2>
        <CheckInForm date={selected} />
      </section>
    </>
  );
}
