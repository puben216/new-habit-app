import { describe, expect, it } from "vitest";
import {
  CHECK_IN_NOTE_MAX_LENGTH,
  checkInDateParamSchema,
  dailyCheckInResponseSchema,
  upsertDailyCheckInRequestSchema,
} from "./check-in";

const parse = (value: unknown) => upsertDailyCheckInRequestSchema.safeParse(value).success;

describe("upsertDailyCheckInRequestSchema(DCI-001/002/INV-004)", () => {
  it("各項目の組み合わせと null を受け付ける", () => {
    expect(parse({ mood: 3 })).toBe(true);
    expect(parse({ mood: 3, difficulty: 5, note: "ok" })).toBe(true);
    expect(parse({ mood: null, difficulty: null, note: null })).toBe(true);
    expect(parse({})).toBe(true); // 「すべて未設定」は Domain が拒否する
  });

  it("mood/difficulty の境界(1/5 は可。0/6/小数/文字列は不可)", () => {
    for (const field of ["mood", "difficulty"]) {
      expect(parse({ [field]: 1 })).toBe(true);
      expect(parse({ [field]: 5 })).toBe(true);
      for (const value of [0, 6, -1, 1.5, "3"]) expect(parse({ [field]: value })).toBe(false);
    }
  });

  it("メモの上限の境界(1000/1001 文字)", () => {
    expect(parse({ note: "あ".repeat(CHECK_IN_NOTE_MAX_LENGTH) })).toBe(true);
    expect(parse({ note: "あ".repeat(CHECK_IN_NOTE_MAX_LENGTH + 1) })).toBe(false);
  });

  it("メモは改行とタブを許可し、他の制御文字を拒否する", () => {
    expect(parse({ note: "1行目\n2行目\tタブ" })).toBe(true);
    for (const ch of ["\u0000", "\u0007", "\r", "\u007f", "\u001b"]) {
      expect(parse({ note: `a${ch}b` })).toBe(false);
    }
  });

  it("未知キー(user の指定を含む)を拒否する", () => {
    expect(parse({ mood: 3, userId: "1" })).toBe(false);
    expect(parse({ mood: 3, date: "2026-01-14" })).toBe(false);
  });
});

describe("checkInDateParamSchema", () => {
  it("実在する暦日のみ受け付ける", () => {
    expect(checkInDateParamSchema.safeParse("2026-01-14").success).toBe(true);
    expect(checkInDateParamSchema.safeParse("2026-02-30").success).toBe(false);
    expect(checkInDateParamSchema.safeParse("2026-1-14").success).toBe(false);
  });
});

describe("dailyCheckInResponseSchema", () => {
  it("応答形を検証できる(未設定は null)", () => {
    const body = {
      date: "2026-01-14",
      mood: 4,
      difficulty: null,
      note: null,
      updatedAt: "2026-01-14T03:00:00.000Z",
    };
    expect(dailyCheckInResponseSchema.safeParse(body).success).toBe(true);
    expect(dailyCheckInResponseSchema.safeParse({ ...body, mood: 9 }).success).toBe(false);
  });
});
