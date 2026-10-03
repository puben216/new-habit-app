import {
  addCalendarDays,
  dayOfWeekOf,
  isBeforeCalendarDate,
  isBeforeOrEqualCalendarDate,
  isValidCalendarDate,
} from "./calendar-date";
import { InvalidScheduleCalculationInputError, OverlappingScheduleVersionError } from "./errors";
import type { ScheduleVersion } from "./schedule-version";

/** `generateOccurrences` が受け付ける範囲の最大日数(両端を含む)。 */
export const MAX_OCCURRENCE_RANGE_DAYS = 366;

/** ある暦日に予定されている実施機会。時刻には紐づかない。 */
export interface ScheduledOccurrence {
  readonly date: string;
  readonly targetCount: number;
  /** 適用された ScheduleVersion の effectiveFrom(どの版で判定したかの識別に使う)。 */
  readonly effectiveFrom: string;
}

export interface OccurrenceRange {
  readonly from: string;
  readonly to: string;
}

function isEffectiveOn(version: ScheduleVersion, date: string): boolean {
  return (
    isBeforeOrEqualCalendarDate(version.effectiveFrom, date) &&
    (version.effectiveTo === null || isBeforeOrEqualCalendarDate(date, version.effectiveTo))
  );
}

/**
 * `date` に有効な ScheduleVersion を返す。該当なしは null。
 * 有効期間は互いに重複しない前提だが、複数該当した場合は黙って先頭を選ばず例外にする。
 */
export function resolveScheduleForDate(
  versions: readonly ScheduleVersion[],
  date: string,
): ScheduleVersion | null {
  if (!isValidCalendarDate(date)) {
    throw new InvalidScheduleCalculationInputError(`Invalid calendar date: ${date}`);
  }
  let found: ScheduleVersion | null = null;
  for (const version of versions) {
    if (!isEffectiveOn(version, date)) {
      continue;
    }
    if (found !== null) {
      throw new OverlappingScheduleVersionError(
        `${date} に有効な ScheduleVersion が複数あります。`,
      );
    }
    found = version;
  }
  return found;
}

/** `date` に予定機会があればそれを、なければ null を返す。 */
export function scheduledOccurrenceOn(
  versions: readonly ScheduleVersion[],
  date: string,
): ScheduledOccurrence | null {
  const version = resolveScheduleForDate(versions, date);
  if (version === null || !version.daysOfWeek.includes(dayOfWeekOf(date))) {
    return null;
  }
  return Object.freeze({
    date,
    targetCount: version.targetCount,
    effectiveFrom: version.effectiveFrom,
  });
}

/** `[from, to]`(両端を含む)の予定機会を日付昇順で返す。`from > to` は空配列。 */
export function generateOccurrences(
  versions: readonly ScheduleVersion[],
  range: OccurrenceRange,
): readonly ScheduledOccurrence[] {
  if (!isValidCalendarDate(range.from) || !isValidCalendarDate(range.to)) {
    throw new InvalidScheduleCalculationInputError("from/to は実在する暦日である必要があります。");
  }
  if (isBeforeCalendarDate(range.to, range.from)) {
    return Object.freeze([]);
  }
  // 上限判定は、上限日数ぶん進めた日付との比較で行い、巨大な範囲を走査しない。
  const lastAllowed = addCalendarDays(range.from, MAX_OCCURRENCE_RANGE_DAYS - 1);
  if (isBeforeCalendarDate(lastAllowed, range.to)) {
    throw new InvalidScheduleCalculationInputError(
      `範囲は ${MAX_OCCURRENCE_RANGE_DAYS} 日以内である必要があります。`,
    );
  }
  const occurrences: ScheduledOccurrence[] = [];
  for (
    let date = range.from;
    !isBeforeCalendarDate(range.to, date);
    date = addCalendarDays(date, 1)
  ) {
    const occurrence = scheduledOccurrenceOn(versions, date);
    if (occurrence !== null) {
      occurrences.push(occurrence);
    }
  }
  return Object.freeze(occurrences);
}
