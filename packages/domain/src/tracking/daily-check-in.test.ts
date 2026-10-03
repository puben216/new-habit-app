import { describe, expect, it } from "vitest";
import { resolveDailyCheckIn } from "./daily-check-in";
import { InvalidDailyCheckInError } from "./errors";

describe("resolveDailyCheckIn", () => {
  it("すべての項目を受理し、未指定は null にする", () => {
    expect(resolveDailyCheckIn({ mood: 4, difficulty: 2, note: "歩いた" })).toEqual({
      mood: 4,
      difficulty: 2,
      note: "歩いた",
    });
    expect(resolveDailyCheckIn({ mood: 5 })).toEqual({ mood: 5, difficulty: null, note: null });
    expect(resolveDailyCheckIn({ difficulty: 1, mood: null })).toEqual({
      mood: null,
      difficulty: 1,
      note: null,
    });
    expect(resolveDailyCheckIn({ note: "メモのみ" })).toEqual({
      mood: null,
      difficulty: null,
      note: "メモのみ",
    });
  });

  it("mood/difficulty の境界(1、5 は可。0、6、小数、非有限は不可)", () => {
    for (const field of ["mood", "difficulty"] as const) {
      expect(resolveDailyCheckIn({ [field]: 1 })[field]).toBe(1);
      expect(resolveDailyCheckIn({ [field]: 5 })[field]).toBe(5);
      for (const value of [0, 6, -1, 1.5, Number.NaN, Infinity]) {
        try {
          resolveDailyCheckIn({ note: "x", [field]: value });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidDailyCheckInError);
          expect((error as InvalidDailyCheckInError).field).toBe(field);
        }
      }
    }
  });

  it("note の前後の空白を除去し、空白のみは未設定にする", () => {
    expect(resolveDailyCheckIn({ mood: 3, note: "  よく眠れた \n" }).note).toBe("よく眠れた");
    expect(resolveDailyCheckIn({ mood: 3, note: "   " }).note).toBeNull();
    expect(resolveDailyCheckIn({ mood: 3, note: "" }).note).toBeNull();
    expect(resolveDailyCheckIn({ mood: 3, note: "1行目\n2行目" }).note).toBe("1行目\n2行目");
  });

  it("すべて未設定の入力を拒否する", () => {
    for (const input of [
      {},
      { mood: null, difficulty: null, note: null },
      { note: "   " },
      { mood: undefined },
    ]) {
      try {
        resolveDailyCheckIn(input);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidDailyCheckInError);
        expect((error as InvalidDailyCheckInError).field).toBe("check_in");
      }
    }
  });
});
