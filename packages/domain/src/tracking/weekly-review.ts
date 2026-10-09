import {
  addCalendarDays,
  isBeforeCalendarDate,
  isValidCalendarDate,
} from "../habits/calendar-date";
import type { HabitKind } from "../habits/habit-kind";
import type { ScheduleVersion } from "../habits/schedule-version";
import { weekStartOf } from "../habits/week";
import { InvalidWeeklyReviewError } from "./errors";
import { aggregateWindowStatistics, calculateRangeStatistics } from "./statistics";
import type { OutcomeCounts, StatisticsEntry } from "./statistics";

/**
 * 週次レビューのスナップショット(summary)と振り返りの定義(docs/specs/weekly-review.md WREV-002/003/005)。
 * 結果分類・成功率は `statistics.ts` の関数を共有し、ここでは再実装しない(WREV-INV-007)。
 */

/** `summary_json` の schema version。形を変える場合は新しい version を追加し、過去の version は書き換えない。 */
export const WEEKLY_REVIEW_SUMMARY_SCHEMA_VERSION = 1;

/** 今日を含む週の開始日から遡って作成できる週数(WREV-002)。この定数が唯一の定義。 */
export const REVIEW_MAX_WEEKS_BACK = 52;

/** 振り返りの最大文字数(DB の CHECK `weekly_reviews_reflection_length_check` と同じ。AI 入力の自由記述上限と同値)。 */
export const WEEKLY_REVIEW_REFLECTION_MAX_LENGTH = 1000;

/** 週の最終日(開始日 + 6 日)。 */
export function weekEndOf(weekStart: string): string {
  return addCalendarDays(weekStart, 6);
}

export type WeekNotReviewableReason = "not_week_start" | "not_ended" | "too_old";

export type ReviewableWeekCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: WeekNotReviewableReason };

/**
 * `weekStart` がレビュー作成の対象にできる週かを判定する。
 * - プロフィールの `weekStartsOn` に一致する、実在する暦日(週の開始日)であること。
 * - 週の最終日が今日より前(終了済み)であること。
 * - 今日を含む週の開始日から `REVIEW_MAX_WEEKS_BACK` 週より前でないこと。
 */
export function checkReviewableWeek(input: {
  readonly weekStart: string;
  readonly today: string;
  readonly weekStartsOn: number;
}): ReviewableWeekCheck {
  const { weekStart, today, weekStartsOn } = input;
  if (!isValidCalendarDate(weekStart) || weekStartOf(weekStart, weekStartsOn) !== weekStart) {
    return { ok: false, reason: "not_week_start" };
  }
  if (!isBeforeCalendarDate(weekEndOf(weekStart), today)) {
    return { ok: false, reason: "not_ended" };
  }
  const oldest = addCalendarDays(weekStartOf(today, weekStartsOn), -7 * REVIEW_MAX_WEEKS_BACK);
  if (isBeforeCalendarDate(weekStart, oldest)) {
    return { ok: false, reason: "too_old" };
  }
  return { ok: true };
}

export interface WeeklyReviewOutcomes extends OutcomeCounts {
  /** `success / (success + missed)`。分母 0 は null。 */
  readonly successRate: number | null;
}

export interface WeeklyReviewHabitSummary extends WeeklyReviewOutcomes {
  /** 習慣の外部 ID(`habits.public_id`)。 */
  readonly habitId: string;
  readonly kind: HabitKind;
  readonly name: string;
}

export interface WeeklyReviewCheckInSummary {
  /** 週内のチェックイン件数(0〜7)。 */
  readonly days: number;
  readonly averageMood: number | null;
  readonly averageDifficulty: number | null;
}

export interface WeeklyReviewSummary {
  readonly schemaVersion: typeof WEEKLY_REVIEW_SUMMARY_SCHEMA_VERSION;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly overall: WeeklyReviewOutcomes;
  /** 週内に予定機会がある習慣のみ。呼び出し側が渡した順(作成が古い順)。 */
  readonly habits: readonly WeeklyReviewHabitSummary[];
  readonly checkIn: WeeklyReviewCheckInSummary;
}

export interface WeeklyReviewHabitInput {
  readonly habitId: string;
  readonly kind: HabitKind;
  readonly name: string;
  readonly scheduleVersions: readonly ScheduleVersion[];
  /** 習慣の記録。週外・予定外の日付が含まれていても無視される。 */
  readonly entries: readonly StatisticsEntry[];
}

export interface WeeklyReviewCheckInInput {
  readonly mood: number | null;
  readonly difficulty: number | null;
}

export interface BuildWeeklyReviewSummaryInput {
  readonly weekStart: string;
  /** 今日(actor の timezone のローカル暦日)。`pending` の判定に使う。 */
  readonly today: string;
  readonly habits: readonly WeeklyReviewHabitInput[];
  /** 週内のチェックイン(呼び出し側が週の範囲で取得したもの)。 */
  readonly checkIns: readonly WeeklyReviewCheckInInput[];
}

function averageOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function outcomesOf(window: WeeklyReviewOutcomes): WeeklyReviewOutcomes {
  return {
    scheduled: window.scheduled,
    success: window.success,
    missed: window.missed,
    skipped: window.skipped,
    pending: window.pending,
    successRate: window.successRate,
  };
}

/**
 * 週次レビューのスナップショットを生成する(WREV-003)。純粋関数で、同じ入力から同じ結果を返す。
 * 習慣の自由記述(purpose/cue 等)・チェックインのメモは入力に含めない。
 */
export function buildWeeklyReviewSummary(
  input: BuildWeeklyReviewSummaryInput,
): WeeklyReviewSummary {
  const { weekStart, today } = input;
  const weekEnd = weekEndOf(weekStart);

  const habits: WeeklyReviewHabitSummary[] = [];
  for (const habit of input.habits) {
    const window = calculateRangeStatistics({
      scheduleVersions: habit.scheduleVersions,
      entries: habit.entries,
      from: weekStart,
      to: weekEnd,
      today,
    });
    if (window.scheduled === 0) continue;
    habits.push({
      habitId: habit.habitId,
      kind: habit.kind,
      name: habit.name,
      ...outcomesOf(window),
    });
  }

  const overall = aggregateWindowStatistics({ from: weekStart, to: weekEnd }, habits);

  return Object.freeze({
    schemaVersion: WEEKLY_REVIEW_SUMMARY_SCHEMA_VERSION,
    weekStart,
    weekEnd,
    overall: outcomesOf(overall),
    habits,
    checkIn: {
      days: input.checkIns.length,
      averageMood: averageOf(input.checkIns.map((checkIn) => checkIn.mood)),
      averageDifficulty: averageOf(input.checkIns.map((checkIn) => checkIn.difficulty)),
    },
  });
}

/**
 * 振り返りを正規化する(WREV-005)。前後の空白を除去し、空になれば null(クリア)。
 * 制御文字の検査は契約 schema が行い、ここでは空白除去後の文字数のみを検証する。
 *
 * @throws {InvalidWeeklyReviewError} 空白除去後が上限を超える
 */
export function normalizeWeeklyReflection(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (trimmed.length > WEEKLY_REVIEW_REFLECTION_MAX_LENGTH) {
    throw new InvalidWeeklyReviewError(
      "reflection",
      `reflection は ${WEEKLY_REVIEW_REFLECTION_MAX_LENGTH} 文字以内である必要があります。`,
    );
  }
  return trimmed;
}
