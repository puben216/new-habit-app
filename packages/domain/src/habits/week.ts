import { addCalendarDays, dayOfWeekOf } from "./calendar-date";
import { InvalidScheduleCalculationInputError } from "./errors";

/**
 * `date` を含む週の開始暦日を返す。`weekStartsOn` は 0(日)〜6(土)
 * (`user_profiles.week_starts_on` と同じ番号付け)。
 */
export function weekStartOf(date: string, weekStartsOn: number): string {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new InvalidScheduleCalculationInputError(
      `weekStartsOn は 0〜6 の整数である必要があります: ${String(weekStartsOn)}`,
    );
  }
  const offset = (dayOfWeekOf(date) - weekStartsOn + 7) % 7;
  return addCalendarDays(date, -offset);
}
