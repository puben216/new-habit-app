import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  dayOfWeekOf,
  isValidCalendarDate,
  previousCalendarDate,
} from "./calendar-date";
import { InvalidScheduleCalculationInputError } from "./errors";

describe("isValidCalendarDate", () => {
  it("実在する暦日を受理する", () => {
    expect(isValidCalendarDate("2024-01-01")).toBe(true);
    expect(isValidCalendarDate("2024-02-29")).toBe(true); // うるう年
  });

  it("実在しない暦日を拒否する", () => {
    expect(isValidCalendarDate("2023-02-29")).toBe(false); // 非うるう年
    expect(isValidCalendarDate("2024-13-01")).toBe(false);
    expect(isValidCalendarDate("2024-00-01")).toBe(false);
    expect(isValidCalendarDate("2024-01-32")).toBe(false);
  });

  it("フォーマットが不正な値を拒否する", () => {
    expect(isValidCalendarDate("2024/01/01")).toBe(false);
    expect(isValidCalendarDate("not-a-date")).toBe(false);
    expect(isValidCalendarDate("")).toBe(false);
  });
});

describe("previousCalendarDate", () => {
  it("前日を返す", () => {
    expect(previousCalendarDate("2024-03-02")).toBe("2024-03-01");
  });

  it("月またぎでも正しく前日を返す", () => {
    expect(previousCalendarDate("2024-03-01")).toBe("2024-02-29"); // うるう年
    expect(previousCalendarDate("2023-03-01")).toBe("2023-02-28");
  });

  it("年またぎでも正しく前日を返す", () => {
    expect(previousCalendarDate("2024-01-01")).toBe("2023-12-31");
  });
});

describe("dayOfWeekOf", () => {
  it("既知の日付の曜日を返す(0=日〜6=土)", () => {
    expect(dayOfWeekOf("2026-01-04")).toBe(0);
    expect(dayOfWeekOf("2026-01-05")).toBe(1);
    expect(dayOfWeekOf("2026-01-10")).toBe(6);
    expect(dayOfWeekOf("2024-02-29")).toBe(4);
  });

  it("実在しない暦日を拒否する", () => {
    expect(() => dayOfWeekOf("2026-02-30")).toThrow(InvalidScheduleCalculationInputError);
  });
});

describe("addCalendarDays", () => {
  it("月・年・うるう日をまたいで加算する", () => {
    expect(addCalendarDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addCalendarDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addCalendarDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addCalendarDays("2023-02-28", 1)).toBe("2023-03-01");
  });

  it("負数と 0 を扱う", () => {
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addCalendarDays("2026-03-01", 0)).toBe("2026-03-01");
    expect(addCalendarDays("2026-01-01", -365)).toBe("2025-01-01");
  });

  it("整数でない日数と不正な暦日を拒否する", () => {
    expect(() => addCalendarDays("2026-01-01", 1.5)).toThrow(InvalidScheduleCalculationInputError);
    expect(() => addCalendarDays("2026-13-01", 1)).toThrow(InvalidScheduleCalculationInputError);
  });
});
