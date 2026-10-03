import { describe, expect, it } from "vitest";
import { InvalidScheduleCalculationInputError } from "./errors";
import { weekStartOf } from "./week";

describe("weekStartOf", () => {
  it("週開始日ごとに、その日を含む週の開始日を返す", () => {
    // 2026-01-07 は水曜
    expect(weekStartOf("2026-01-07", 1)).toBe("2026-01-05");
    expect(weekStartOf("2026-01-07", 0)).toBe("2026-01-04");
    expect(weekStartOf("2026-01-07", 3)).toBe("2026-01-07");
    expect(weekStartOf("2026-01-07", 4)).toBe("2026-01-01");
    expect(weekStartOf("2026-01-07", 6)).toBe("2026-01-03");
  });

  it("開始日当日はその日自身を返す", () => {
    expect(weekStartOf("2026-01-05", 1)).toBe("2026-01-05");
  });

  it("日曜が月曜始まりの週の末日になる", () => {
    expect(weekStartOf("2026-01-11", 1)).toBe("2026-01-05");
  });

  it("年・月をまたぐ", () => {
    expect(weekStartOf("2026-01-01", 1)).toBe("2025-12-29");
    expect(weekStartOf("2024-03-01", 1)).toBe("2024-02-26");
  });

  it("不正な weekStartsOn を拒否する", () => {
    for (const value of [-1, 7, 1.5, Number.NaN]) {
      expect(() => weekStartOf("2026-01-07", value)).toThrow(InvalidScheduleCalculationInputError);
    }
  });

  it("実在しない暦日を拒否する", () => {
    expect(() => weekStartOf("2026-02-30", 1)).toThrow(InvalidScheduleCalculationInputError);
  });
});
