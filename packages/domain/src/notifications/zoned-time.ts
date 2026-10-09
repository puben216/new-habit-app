import { isValidCalendarDate } from "../habits/calendar-date";
import { InvalidNotificationPreferenceError } from "./errors";
import { isLocalTime } from "./notification-preference";

/**
 * timezone つきの時刻計算(docs/specs/notification-delivery.md NDL-INV-006)。
 * `Intl.DateTimeFormat` を使うため DB・ネットワークに依存しない純粋関数。timezone は
 * `parseTimezone` で検証済みの IANA ID を前提とする。
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      calendar: "gregory",
      numberingSystem: "latn",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** ある瞬間の、timezone でのローカル日時の各要素。 */
export interface LocalDateTime {
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** `HH:mm` */
  readonly time: string;
}

function localFields(instantMs: number, timezone: string) {
  const parts = formatterFor(timezone).formatToParts(new Date(instantMs));
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

/** その瞬間の UTC からの offset(ミリ秒。東が正)。 */
function offsetMsAt(instantMs: number, timezone: string): number {
  const f = localFields(instantMs, timezone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  const truncated = instantMs - (((instantMs % 1000) + 1000) % 1000);
  return asUtc - truncated;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ある瞬間の timezone でのローカル日付と時刻(分単位)。 */
export function localDateTimeAt(instant: Date, timezone: string): LocalDateTime {
  const f = localFields(instant.getTime(), timezone);
  return {
    date: `${String(f.year).padStart(4, "0")}-${pad(f.month)}-${pad(f.day)}`,
    time: `${pad(f.hour)}:${pad(f.minute)}`,
  };
}

/**
 * ローカル日付 + ローカル時刻 + timezone を UTC の瞬間へ変換する。
 *
 * - 存在しないローカル時刻(DST の spring-forward の gap)は、gap の直後の最初の瞬間にする。
 * - 曖昧なローカル時刻(fall-back の重複)は、早い方の瞬間にする。
 *
 * @throws {InvalidNotificationPreferenceError} 日付・時刻の形式が不正
 */
export function resolveReminderSlot(localDate: string, localTime: string, timezone: string): Date {
  if (!isValidCalendarDate(localDate)) {
    throw new InvalidNotificationPreferenceError("localTime", "ローカル日付が不正です。");
  }
  if (!isLocalTime(localTime)) {
    throw new InvalidNotificationPreferenceError("localTime", "localTime は HH:mm 形式です。");
  }
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const hour = Number(localTime.slice(0, 2));
  const minute = Number(localTime.slice(3, 5));
  // ローカル時刻をそのまま UTC として読んだ値。実際の瞬間は offset を引いたもの。
  const wall = Date.UTC(year, month - 1, day, hour, minute);

  const candidateOffsets = new Set([
    offsetMsAt(wall - MS_PER_DAY, timezone),
    offsetMsAt(wall + MS_PER_DAY, timezone),
  ]);
  const valid: number[] = [];
  for (const offset of candidateOffsets) {
    const instant = wall - offset;
    if (offsetMsAt(instant, timezone) === offset) valid.push(instant);
  }
  if (valid.length > 0) return new Date(Math.min(...valid));

  // gap: 前後 2 つの offset の瞬間の間にある遷移点(offset が切り替わる最初の分)を二分探索する。
  const instants = [...candidateOffsets].map((offset) => wall - offset).sort((a, b) => a - b);
  const lo = instants[0];
  const hi = instants[instants.length - 1];
  if (lo === undefined || hi === undefined) return new Date(wall);
  const before = offsetMsAt(lo, timezone);
  let low = Math.floor(lo / MS_PER_MINUTE);
  let high = Math.ceil(hi / MS_PER_MINUTE);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsetMsAt(mid * MS_PER_MINUTE, timezone) === before) low = mid + 1;
    else high = mid;
  }
  return new Date(low * MS_PER_MINUTE);
}
