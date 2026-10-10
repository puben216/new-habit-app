"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/button";
import { StateMessage } from "@/components/state-message";
import { DASHBOARD_QUERY_KEY, fetchDashboard } from "@/lib/dashboard/dashboard-api";
import { streakText } from "@/lib/dashboard/format";
import { kindLabel } from "@/lib/habits/labels";

import styles from "./dashboard.module.css";
import { Breakdown, RateLine, WindowSummary } from "./window-summary";

export function DashboardView() {
  const query = useQuery({
    queryKey: DASHBOARD_QUERY_KEY,
    queryFn: ({ signal }) => fetchDashboard(signal),
  });

  if (query.isPending) return <StateMessage kind="loading" title="読み込んでいます" />;
  if (query.isError) {
    return (
      <StateMessage
        kind="error"
        title="ダッシュボードを読み込めませんでした"
        description="時間をおいてもう一度お試しください。"
        action={<Button onClick={() => void query.refetch()}>もう一度試す</Button>}
      />
    );
  }

  const { overall, habits } = query.data;

  if (habits.length === 0) {
    return (
      <StateMessage
        kind="empty"
        title="進行中の習慣がありません"
        description="習慣を作って記録を始めると、ここに振り返りが表示されます。"
        action={<Link href="/habits/new">習慣を作る</Link>}
      />
    );
  }

  return (
    <>
      <section aria-labelledby="overall-heading">
        <h2 id="overall-heading">全体</h2>
        <div className={styles["cards"]}>
          <WindowSummary title="直近7日" stats={overall.last7Days} />
          <WindowSummary title="直近30日" stats={overall.last30Days} />
        </div>
      </section>

      <details className={styles["definition"]}>
        <summary>数値の見方</summary>
        <ul>
          <li>成功率 = 成功 ÷(成功 + 未実施)です。</li>
          <li>スキップは成功率に含めません。</li>
          <li>今日の未記録は「保留」とし、成功率に含めず、連続も切りません。</li>
          <li>過去の未記録は「未実施」として数えます。</li>
          <li>
            連続回数は予定された機会の数です。成功で増え、未実施で 0
            に戻り、スキップと保留では変わりません。
          </li>
        </ul>
      </details>

      <section aria-labelledby="habits-heading">
        <h2 id="habits-heading">習慣ごと</h2>
        <ul className={styles["habits"]}>
          {habits.map((entry) => (
            <li key={entry.habit.id} className={styles["card"]}>
              <h3 className={styles["cardTitle"]}>
                <Link href={`/habits/${entry.habit.id}`}>{entry.habit.name}</Link>
                <span className={styles["period"]}>({kindLabel(entry.habit.kind)})</span>
              </h3>
              <p className={styles["streak"]}>
                {streakText(entry.currentStreak, entry.longestStreak)}
              </p>
              <div className={styles["windows"]}>
                <div>
                  <h4 className={styles["windowTitle"]}>直近7日</h4>
                  <RateLine stats={entry.last7Days} />
                  <Breakdown stats={entry.last7Days} />
                </div>
                <div>
                  <h4 className={styles["windowTitle"]}>直近30日</h4>
                  <RateLine stats={entry.last30Days} />
                  <Breakdown stats={entry.last30Days} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
