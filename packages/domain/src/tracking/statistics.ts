import {
  addCalendarDays,
  isBeforeCalendarDate,
  isValidCalendarDate,
} from "../habits/calendar-date";
import { InvalidScheduleCalculationInputError } from "../habits/errors";
import { MAX_OCCURRENCE_RANGE_DAYS, generateOccurrences } from "../habits/occurrence";
import type { ScheduleVersion } from "../habits/schedule-version";
import type { HabitEntryStatus } from "./habit-entry";

/**
 * 統計(ストリーク・成功率)の定義(docs/specs/statistics-dashboard.md STAT-002〜005、
 * docs/04-database-design.md「集計定義」)。この関数群を唯一の定義とし、
 * Application/Infrastructure は再実装しない。
 */

/** ストリークを遡る日数(今日を含む)。`generateOccurrences` の範囲上限と同じ。 */
export const STREAK_LOOKBACK_DAYS = MAX_OCCURRENCE_RANGE_DAYS;

/** 成功率の期間(今日を含む直近 N 日)。 */
export const STATISTICS_WINDOW_DAYS = { short: 7, long: 30 } as const;

/**
 * 予定機会 1 件の結果。
 * `pending` は「記録がなく、日付が今日」で、今日が終わるまで確定しない。
 */
export type OccurrenceOutcome = HabitEntryStatus | "pending";

export interface StatisticsEntry {
  readonly date: string;
  readonly status: HabitEntryStatus;
}

export interface OutcomeCounts {
  readonly scheduled: number;
  readonly success: number;
  readonly missed: number;
  readonly skipped: number;
  readonly pending: number;
}

export interface WindowStatistics extends OutcomeCounts {
  readonly from: string;
  readonly to: string;
  /** `success / (success + missed)`。分母 0 は null。 */
  readonly successRate: number | null;
}

export interface HabitStatistics {
  readonly currentStreak: number;
  readonly longestStreak: number;
  readonly last7Days: WindowStatistics;
  readonly last30Days: WindowStatistics;
}

export interface CalculateHabitStatisticsInput {
  readonly scheduleVersions: readonly ScheduleVersion[];
  readonly entries: readonly StatisticsEntry[];
  /** 今日(actor の timezone のローカル暦日)。 */
  readonly today: string;
}

function successRateOf(counts: OutcomeCounts): number | null {
  const denominator = counts.success + counts.missed;
  return denominator === 0 ? null : counts.success / denominator;
}

function emptyCounts(): { -readonly [K in keyof OutcomeCounts]: number } {
  return { scheduled: 0, success: 0, missed: 0, skipped: 0, pending: 0 };
}

function windowStatistics(from: string, to: string, counts: OutcomeCounts): WindowStatistics {
  return Object.freeze({ from, to, ...counts, successRate: successRateOf(counts) });
}

/**
 * 1 習慣の統計を求める。
 *
 * - 対象は `[today - (STREAK_LOOKBACK_DAYS - 1), today]` の予定機会。予定のない日の記録は無視する。
 * - 記録がない予定機会は、日付が今日より前なら `missed`(未実施)、今日なら `pending`。
 * - ストリーク: success で +1、missed で 0、skipped/pending は変えない。非予定日は予定機会に含まれない。
 */
export function calculateHabitStatistics(input: CalculateHabitStatisticsInput): HabitStatistics {
  const { scheduleVersions, entries, today } = input;
  if (!isValidCalendarDate(today)) {
    throw new InvalidScheduleCalculationInputError(`Invalid calendar date: ${today}`);
  }

  const statusByDate = new Map<string, HabitEntryStatus>();
  for (const entry of entries) {
    statusByDate.set(entry.date, entry.status);
  }

  const lookbackFrom = addCalendarDays(today, -(STREAK_LOOKBACK_DAYS - 1));
  const shortFrom = addCalendarDays(today, -(STATISTICS_WINDOW_DAYS.short - 1));
  const longFrom = addCalendarDays(today, -(STATISTICS_WINDOW_DAYS.long - 1));

  const occurrences = generateOccurrences(scheduleVersions, { from: lookbackFrom, to: today });

  const shortCounts = emptyCounts();
  const longCounts = emptyCounts();
  let currentStreak = 0;
  let longestStreak = 0;

  for (const occurrence of occurrences) {
    const recorded = statusByDate.get(occurrence.date);
    const outcome: OccurrenceOutcome =
      recorded ?? (isBeforeCalendarDate(occurrence.date, today) ? "missed" : "pending");

    switch (outcome) {
      case "success":
        currentStreak += 1;
        longestStreak = Math.max(longestStreak, currentStreak);
        break;
      case "missed":
        currentStreak = 0;
        break;
      case "skipped":
      case "pending":
        break;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }

    for (const [from, counts] of [
      [longFrom, longCounts],
      [shortFrom, shortCounts],
    ] as const) {
      if (!isBeforeCalendarDate(occurrence.date, from)) {
        counts.scheduled += 1;
        counts[outcome] += 1;
      }
    }
  }

  return Object.freeze({
    currentStreak,
    longestStreak,
    last7Days: windowStatistics(shortFrom, today, shortCounts),
    last30Days: windowStatistics(longFrom, today, longCounts),
  });
}

/**
 * 同じ期間の `WindowStatistics` を合算する(全体用)。成功率は習慣ごとの率の平均ではなく、
 * 合計した件数から求める。`windows` が空の場合は `period` の期間で件数 0 を返す。
 */
export function aggregateWindowStatistics(
  period: { readonly from: string; readonly to: string },
  windows: readonly OutcomeCounts[],
): WindowStatistics {
  const total = emptyCounts();
  for (const window of windows) {
    total.scheduled += window.scheduled;
    total.success += window.success;
    total.missed += window.missed;
    total.skipped += window.skipped;
    total.pending += window.pending;
  }
  return windowStatistics(period.from, period.to, total);
}
