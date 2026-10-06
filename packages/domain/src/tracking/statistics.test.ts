import { describe, expect, it } from "vitest";
import { addCalendarDays } from "../habits/calendar-date";
import { InvalidScheduleCalculationInputError } from "../habits/errors";
import { localDateAt } from "../habits/local-date";
import { createScheduleVersion } from "../habits/schedule-version";
import type { ScheduleVersion } from "../habits/schedule-version";
import type { HabitEntryStatus } from "./habit-entry";
import {
  STREAK_LOOKBACK_DAYS,
  aggregateWindowStatistics,
  calculateHabitStatistics,
} from "./statistics";
import type { StatisticsEntry } from "./statistics";

// 2026-01-14 は水曜日。
const TODAY = "2026-01-14";
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

function daily(effectiveFrom = "2020-01-01"): ScheduleVersion[] {
  return [createScheduleVersion("build", { effectiveFrom, daysOfWeek: EVERY_DAY, targetCount: 1 })];
}

/** `today` から `daysAgo` 日前の暦日。 */
function ago(daysAgo: number, today = TODAY): string {
  return addCalendarDays(today, -daysAgo);
}

function entry(daysAgo: number, status: HabitEntryStatus, today = TODAY): StatisticsEntry {
  return { date: ago(daysAgo, today), status };
}

describe("calculateHabitStatistics: 予定機会ごとの結果と成功率", () => {
  it("記録がなければ今日は pending、過去は missed、成功率は success=0 なので 0", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(),
      entries: [],
      today: TODAY,
    });
    expect(stats.last7Days).toEqual({
      from: "2026-01-08",
      to: TODAY,
      scheduled: 7,
      success: 0,
      missed: 6,
      skipped: 0,
      pending: 1,
      successRate: 0,
    });
    expect(stats.last30Days.from).toBe("2025-12-16");
    expect(stats.last30Days.scheduled).toBe(30);
    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(0);
  });

  it("success 4 / missed 1 / 記録なし 1 / 今日は未記録 → 4/6 で今日は保留", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(),
      entries: [
        entry(1, "success"),
        entry(2, "success"),
        entry(3, "missed"),
        entry(4, "success"),
        entry(5, "success"),
        // 6 日前は記録なし(= missed)
      ],
      today: TODAY,
    });
    expect(stats.last7Days).toMatchObject({
      scheduled: 7,
      success: 4,
      missed: 2,
      skipped: 0,
      pending: 1,
      successRate: 4 / 6,
    });
  });

  it("skipped は分母から除外される", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: [
        createScheduleVersion("build", {
          effectiveFrom: ago(4),
          daysOfWeek: EVERY_DAY,
          targetCount: 1,
        }),
      ],
      entries: [
        entry(4, "success"),
        entry(3, "skipped"),
        entry(2, "success"),
        entry(1, "skipped"),
        entry(0, "success"),
      ],
      today: TODAY,
    });
    expect(stats.last7Days).toMatchObject({
      scheduled: 5,
      success: 3,
      skipped: 2,
      missed: 0,
      pending: 0,
      successRate: 1,
    });
  });

  it("分母が 0(全て skipped)なら null", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: [
        createScheduleVersion("build", {
          effectiveFrom: ago(1),
          daysOfWeek: EVERY_DAY,
          targetCount: 1,
        }),
      ],
      entries: [entry(1, "skipped"), entry(0, "skipped")],
      today: TODAY,
    });
    expect(stats.last7Days.successRate).toBeNull();
    expect(stats.last7Days.skipped).toBe(2);
  });

  it("今日だけが予定機会で未記録なら pending=1、成功率 null、ストリーク 0", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: [
        createScheduleVersion("build", {
          effectiveFrom: TODAY,
          daysOfWeek: EVERY_DAY,
          targetCount: 1,
        }),
      ],
      entries: [],
      today: TODAY,
    });
    expect(stats.last7Days).toMatchObject({ scheduled: 1, pending: 1, successRate: null });
    expect(stats.currentStreak).toBe(0);
  });

  it("今日記録済みなら今日も集計する(missed の記録は未実施)", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: [
        createScheduleVersion("build", {
          effectiveFrom: TODAY,
          daysOfWeek: EVERY_DAY,
          targetCount: 1,
        }),
      ],
      entries: [entry(0, "missed")],
      today: TODAY,
    });
    expect(stats.last7Days).toMatchObject({ scheduled: 1, missed: 1, pending: 0, successRate: 0 });
  });

  it("習慣の作成前(最初の予定機会より前)は対象外", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(ago(2)),
      entries: [],
      today: TODAY,
    });
    expect(stats.last7Days.scheduled).toBe(3);
    expect(stats.last30Days.scheduled).toBe(3);
  });

  it("予定のない日の記録は無視する", () => {
    // 水曜(今日)だけが予定。昨日(火)の記録は予定外。
    const stats = calculateHabitStatistics({
      scheduleVersions: [
        createScheduleVersion("build", {
          effectiveFrom: "2020-01-01",
          daysOfWeek: [3],
          targetCount: 1,
        }),
      ],
      entries: [entry(1, "success"), entry(0, "success")],
      today: TODAY,
    });
    // 7 日の期間(1/8〜1/14)の予定は今日(水)だけ。昨日(火)の success は予定外なので数えない。
    expect(stats.last7Days).toMatchObject({ scheduled: 1, success: 1, missed: 0 });
    // 30 日の期間の予定は水曜 5 回(12/17, 12/24, 12/31, 1/7, 1/14)。記録があるのは今日だけ。
    expect(stats.last30Days).toMatchObject({ scheduled: 5, success: 1, missed: 4 });
  });

  it("7 日・30 日の期間境界は今日を含む直近 N 日", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(),
      entries: [
        entry(0, "success"),
        entry(6, "success"),
        entry(7, "success"),
        entry(29, "success"),
        entry(30, "success"),
      ],
      today: TODAY,
    });
    // 7 日: 0〜6 日前の success は 2 件(0, 6)。7 日前は含まない。
    expect(stats.last7Days.success).toBe(2);
    expect(stats.last7Days.from).toBe(ago(6));
    // 30 日: 0〜29 日前の success は 4 件(0, 6, 7, 29)。30 日前は含まない。
    expect(stats.last30Days.success).toBe(4);
    expect(stats.last30Days.from).toBe(ago(29));
    expect(stats.last30Days.to).toBe(TODAY);
  });

  it("ScheduleVersion の切替前後で、その日に有効な版の予定機会だけを集計する", () => {
    // 2026-01-07(水)まで水曜が予定、2026-01-08 以降は火曜が予定。
    const versions = [
      createScheduleVersion("build", {
        effectiveFrom: "2020-01-01",
        effectiveTo: "2026-01-07",
        daysOfWeek: [3],
        targetCount: 1,
      }),
      createScheduleVersion("build", {
        effectiveFrom: "2026-01-08",
        daysOfWeek: [2],
        targetCount: 1,
      }),
    ];
    const stats = calculateHabitStatistics({
      scheduleVersions: versions,
      entries: [
        { date: "2026-01-07", status: "success" }, // 旧版の水曜
        { date: "2026-01-13", status: "success" }, // 新版の火曜
        { date: "2026-01-14", status: "success" }, // 新版では水曜は予定外
      ],
      today: TODAY,
    });
    // 7 日の期間は 1/8〜1/14。予定は 1/13(火)だけ。
    expect(stats.last7Days).toMatchObject({ scheduled: 1, success: 1 });
    // 30 日の期間では旧版の水曜(12/17, 12/24, 12/31, 1/7)と新版の火曜(1/13)
    expect(stats.last30Days.scheduled).toBe(5);
    expect(stats.last30Days.success).toBe(2);
  });

  it("DST 日を含む timezone でも、ローカルの今日を基準に 7 日が決まる", () => {
    // America/New_York: 2026-03-08 に DST 開始。UTC 2026-03-09T03:30Z の現地は 2026-03-08 23:30。
    const today = localDateAt(new Date("2026-03-09T03:30:00Z"), "America/New_York");
    expect(today).toBe("2026-03-08");
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(),
      entries: [],
      today,
    });
    expect(stats.last7Days.from).toBe("2026-03-02");
    expect(stats.last7Days.to).toBe("2026-03-08");
    expect(stats.last7Days.scheduled).toBe(7);
  });

  it("today が不正な暦日なら例外", () => {
    expect(() =>
      calculateHabitStatistics({ scheduleVersions: daily(), entries: [], today: "2026-02-30" }),
    ).toThrow(InvalidScheduleCalculationInputError);
  });
});

describe("calculateHabitStatistics: ストリーク", () => {
  it("success が続く限り数え、今日の未記録は保留して切らない", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(),
      entries: [entry(1, "success"), entry(2, "success"), entry(3, "success")],
      today: TODAY,
    });
    // 4 日前以前は記録なし(= missed)。
    expect(stats.currentStreak).toBe(3);
    expect(stats.longestStreak).toBe(3);
  });

  it("今日が success なら含める", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(),
      entries: [entry(0, "success"), entry(1, "success"), entry(2, "success"), entry(3, "success")],
      today: TODAY,
    });
    expect(stats.currentStreak).toBe(4);
  });

  it("missed(記録なしの過去日を含む)で 0 に戻り、最長は別に保持する", () => {
    // 古い順: success, success, missed, success
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(ago(3)),
      entries: [entry(3, "success"), entry(2, "success"), entry(1, "missed"), entry(0, "success")],
      today: TODAY,
    });
    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(2);
  });

  it("記録がない過去の予定機会は missed としてストリークを切る", () => {
    // 古い順: success, (記録なし), success(今日)
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(ago(2)),
      entries: [entry(2, "success"), entry(0, "success")],
      today: TODAY,
    });
    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(1);
  });

  it("skipped はストリークを切らず、数えない", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(ago(2)),
      entries: [entry(2, "success"), entry(1, "skipped"), entry(0, "success")],
      today: TODAY,
    });
    expect(stats.currentStreak).toBe(2);
    expect(stats.longestStreak).toBe(2);
  });

  it("非予定日は切断しない(月・水・金の予定)", () => {
    // 2026-01-14 は水曜。月 1/12・水 1/14(今日)・金 1/9・水 1/7 が予定。
    const stats = calculateHabitStatistics({
      scheduleVersions: [
        createScheduleVersion("build", {
          effectiveFrom: "2026-01-05",
          daysOfWeek: [1, 3, 5],
          targetCount: 1,
        }),
      ],
      entries: [
        { date: "2026-01-05", status: "success" }, // 月
        { date: "2026-01-07", status: "success" }, // 水
        { date: "2026-01-09", status: "success" }, // 金
        { date: "2026-01-12", status: "success" }, // 月
        // 今日(水)は未記録 = pending
      ],
      today: TODAY,
    });
    expect(stats.currentStreak).toBe(4);
    expect(stats.last7Days).toMatchObject({ scheduled: 3, success: 2, pending: 1 });
  });

  it("全期間が success でも最大 366 日分の予定機会までで打ち切る", () => {
    const entries: StatisticsEntry[] = [];
    for (let i = 0; i < 400; i += 1) entries.push(entry(i, "success"));
    const stats = calculateHabitStatistics({
      scheduleVersions: daily(),
      entries,
      today: TODAY,
    });
    expect(stats.currentStreak).toBe(STREAK_LOOKBACK_DAYS);
    expect(stats.longestStreak).toBe(STREAK_LOOKBACK_DAYS);
  });

  it("予定機会がない習慣は 0", () => {
    const stats = calculateHabitStatistics({
      scheduleVersions: [],
      entries: [entry(1, "success")],
      today: TODAY,
    });
    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(0);
    expect(stats.last7Days).toMatchObject({ scheduled: 0, successRate: null });
  });
});

describe("calculateHabitStatistics: 性質テスト(シード固定)", () => {
  /** 決定的な擬似乱数(LCG)。 */
  function rng(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  it("scheduled = success + missed + skipped + pending、成功率は 0〜1 または null、最長 >= 現在", () => {
    const random = rng(20261004);
    const statuses: HabitEntryStatus[] = ["success", "missed", "skipped"];
    for (let run = 0; run < 200; run += 1) {
      const daysOfWeek = EVERY_DAY.filter(() => random() < 0.5);
      if (daysOfWeek.length === 0) daysOfWeek.push(1);
      const versions = [
        createScheduleVersion("build", {
          effectiveFrom: ago(Math.floor(random() * 100)),
          daysOfWeek,
          targetCount: 1,
        }),
      ];
      const entries: StatisticsEntry[] = [];
      for (let d = 0; d < 60; d += 1) {
        if (random() < 0.6) {
          entries.push(entry(d, statuses[Math.floor(random() * statuses.length)] ?? "success"));
        }
      }
      const stats = calculateHabitStatistics({ scheduleVersions: versions, entries, today: TODAY });
      for (const window of [stats.last7Days, stats.last30Days]) {
        expect(window.scheduled).toBe(
          window.success + window.missed + window.skipped + window.pending,
        );
        expect(window.pending).toBeLessThanOrEqual(1);
        if (window.successRate !== null) {
          expect(window.successRate).toBeGreaterThanOrEqual(0);
          expect(window.successRate).toBeLessThanOrEqual(1);
        } else {
          expect(window.success + window.missed).toBe(0);
        }
      }
      expect(stats.last7Days.scheduled).toBeLessThanOrEqual(stats.last30Days.scheduled);
      expect(stats.longestStreak).toBeGreaterThanOrEqual(stats.currentStreak);
    }
  });
});

describe("aggregateWindowStatistics", () => {
  const period = { from: "2026-01-08", to: TODAY };

  it("習慣ごとの率の平均ではなく、合計した件数から成功率を求める", () => {
    const a = { scheduled: 1, success: 1, missed: 0, skipped: 0, pending: 0 };
    const b = { scheduled: 3, success: 1, missed: 2, skipped: 0, pending: 0 };
    const total = aggregateWindowStatistics(period, [a, b]);
    expect(total).toEqual({
      ...period,
      scheduled: 4,
      success: 2,
      missed: 2,
      skipped: 0,
      pending: 0,
      successRate: 0.5,
    });
  });

  it("空なら件数 0、成功率 null", () => {
    expect(aggregateWindowStatistics(period, [])).toEqual({
      ...period,
      scheduled: 0,
      success: 0,
      missed: 0,
      skipped: 0,
      pending: 0,
      successRate: null,
    });
  });
});
