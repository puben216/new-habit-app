import { describe, expect, it } from "vitest";

import { localDateTimeAt, resolveReminderSlot } from "./zoned-time";

const TIMEZONES = [
  "UTC",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "America/New_York",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "Pacific/Auckland",
  "Pacific/Chatham",
];

const pad = (n: number) => String(n).padStart(2, "0");
const toTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const dateString = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** UTC 正午のローカル時刻から、その日の代表的な offset(分)を求める。 */
function noonOffsetMinutes(dayMs: number, timezone: string): number {
  const local = localDateTimeAt(new Date(dayMs + 12 * 3_600_000), timezone);
  const [h, m] = local.time.split(":").map(Number) as [number, number];
  const dayShift = local.date === dateString(dayMs) ? 0 : local.date > dateString(dayMs) ? 1 : -1;
  return dayShift * 1440 + h * 60 + m - 12 * 60;
}

/** 2026 年のうち、offset が変わる日を timezone ごとに集める。 */
function transitionDays(timezone: string): string[] {
  const start = Date.UTC(2026, 0, 1);
  const days = new Set<string>();
  for (let i = 1; i < 365; i += 1) {
    const prev = noonOffsetMinutes(start + (i - 1) * 86_400_000, timezone);
    const curr = noonOffsetMinutes(start + i * 86_400_000, timezone);
    if (prev !== curr) {
      days.add(dateString(start + i * 86_400_000));
    }
  }
  return [...days];
}

describe("resolveReminderSlot の不変条件(DST の遷移日を全分で検証)", () => {
  it("存在するローカル時刻は入力どおりに戻る。存在しない時刻(gap)は gap の直後の最初の時刻になる", () => {
    let gapMinutes = 0;
    let checked = 0;
    for (const timezone of TIMEZONES) {
      for (const date of transitionDays(timezone)) {
        for (let minutes = 0; minutes < 1440; minutes += 1) {
          const time = toTime(minutes);
          const slot = resolveReminderSlot(date, time, timezone);
          const local = localDateTimeAt(slot, timezone);
          checked += 1;
          if (local.date === date && local.time === time) continue;

          gapMinutes += 1;
          const input = `${date} ${time}`;
          expect(`${local.date} ${local.time}` > input).toBe(true);
          const prev = localDateTimeAt(new Date(slot.getTime() - 60_000), timezone);
          expect(`${prev.date} ${prev.time}` < input).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    // 検査が空振りしていないこと(spring-forward の gap が実際に現れている)。
    expect(gapMinutes).toBeGreaterThan(100);
  }, 30_000);

  it("fall-back の重複では、同じローカル時刻をもつ 2 つの瞬間のうち早い方が選ばれる", () => {
    let ambiguous = 0;
    for (const timezone of TIMEZONES) {
      for (const date of transitionDays(timezone)) {
        for (let minutes = 0; minutes < 1440; minutes += 1) {
          const time = toTime(minutes);
          const slot = resolveReminderSlot(date, time, timezone);
          const local = localDateTimeAt(slot, timezone);
          if (local.date !== date || local.time !== time) continue; // gap は別のテスト

          // 選んだ瞬間より前の 2 時間に同じローカル時刻が現れていないこと(= 早い方)。
          const earlierSame = [30, 60, 90, 120].some((delta) => {
            const e = localDateTimeAt(new Date(slot.getTime() - delta * 60_000), timezone);
            return e.date === date && e.time === time;
          });
          expect(earlierSame).toBe(false);
          // 後の 2 時間に同じローカル時刻が現れるなら、それは重複(選んだのが早い方であること)。
          const laterSame = [30, 60, 90, 120].some((delta) => {
            const l = localDateTimeAt(new Date(slot.getTime() + delta * 60_000), timezone);
            return l.date === date && l.time === time;
          });
          if (laterSame) ambiguous += 1;
        }
      }
    }
    expect(ambiguous).toBeGreaterThan(50);
  }, 30_000);
});
