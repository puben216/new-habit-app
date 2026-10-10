import type { WindowStatisticsResponse } from "@habit-app/contracts";

import { formatPeriod, formatRate, rateMeterValue } from "@/lib/dashboard/format";

import styles from "./dashboard.module.css";

/** 件数内訳。0 も表示し、色に依存せずラベルで示す。 */
export function Breakdown({ stats }: { stats: WindowStatisticsResponse }) {
  return (
    <dl className={styles["breakdown"]}>
      <div>
        <dt>成功</dt>
        <dd>{stats.success}</dd>
      </div>
      <div>
        <dt>未実施</dt>
        <dd>{stats.missed}</dd>
      </div>
      <div>
        <dt>スキップ</dt>
        <dd>{stats.skipped}</dd>
      </div>
      <div>
        <dt>保留</dt>
        <dd>{stats.pending}</dd>
      </div>
    </dl>
  );
}

export function RateLine({ stats }: { stats: WindowStatisticsResponse }) {
  return (
    <p className={styles["rate"]}>
      <span className={styles["rateLabel"]}>成功率</span>{" "}
      <strong>{formatRate(stats.successRate)}</strong>
      {stats.successRate === null ? null : (
        <meter
          min={0}
          max={100}
          value={rateMeterValue(stats.successRate)}
          aria-hidden="true"
          className={styles["meter"]}
        />
      )}
    </p>
  );
}

export function WindowSummary({
  title,
  stats,
}: {
  title: string;
  stats: WindowStatisticsResponse;
}) {
  return (
    <section className={styles["card"]} aria-label={title}>
      <h3 className={styles["cardTitle"]}>
        {title}
        <span className={styles["period"]}>({formatPeriod(stats.from, stats.to)})</span>
      </h3>
      <RateLine stats={stats} />
      <Breakdown stats={stats} />
    </section>
  );
}
