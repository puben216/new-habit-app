/**
 * `habit_schedule_versions.effective_from` / `effective_to` に対応する、
 * タイムゾーンを持たない暦日(calendar date)を扱う内部ヘルパー。
 *
 * docs/04-database-design.md の方針どおり、習慣のローカル日は `date` 型として
 * timezone を持たない値で表現する。Domain では ISO 8601 の `YYYY-MM-DD` 文字列を
 * 唯一の表現とし、比較は文字列の辞書順(この形式では暦日順と一致する)で行う。
 * これは Application/Infrastructure 層の Clock や IANA timezone の話とは独立な、
 * 純粋な暦計算のみを扱う。
 */

import { InvalidScheduleCalculationInputError } from "./errors";

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** `a` が `b` より前の暦日であれば true。 */
export function isBeforeCalendarDate(a: string, b: string): boolean {
  return a < b;
}

/** `a` が `b` 以前の暦日であれば true。 */
export function isBeforeOrEqualCalendarDate(a: string, b: string): boolean {
  return a <= b;
}

function parseCalendarDate(value: string): Date {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match || !isValidCalendarDate(value)) {
    throw new InvalidScheduleCalculationInputError(`Invalid calendar date: ${value}`);
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatCalendarDate(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 暦日文字列の前日を返す。 */
export function previousCalendarDate(value: string): string {
  return addCalendarDays(value, -1);
}

/** 暦日を `days` 日(負数可)進めた暦日を返す。UTC の暦演算のため DST の影響を受けない。 */
export function addCalendarDays(value: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new InvalidScheduleCalculationInputError(`days は整数である必要があります: ${days}`);
  }
  const date = parseCalendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatCalendarDate(date);
}

/** 暦日の曜日を返す。0(日)〜6(土)。ScheduleVersion.daysOfWeek と同じ番号付け。 */
export function dayOfWeekOf(value: string): number {
  return parseCalendarDate(value).getUTCDay();
}
