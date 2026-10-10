import { describe, expect, it } from "vitest";
import {
  HABIT_ENTRY_MAX_QUANTITY,
  habitEntryDateParamSchema,
  habitEntryResponseSchema,
  todayScheduleResponseSchema,
  upsertHabitEntryRequestSchema,
} from "./tracking";

describe("upsertHabitEntryRequestSchema(HENT-002)", () => {
  it("status のみ、status+quantity、quantity: null を受け付ける", () => {
    expect(upsertHabitEntryRequestSchema.safeParse({ status: "success" }).success).toBe(true);
    expect(upsertHabitEntryRequestSchema.safeParse({ status: "missed", quantity: 2 }).success).toBe(
      true,
    );
    expect(
      upsertHabitEntryRequestSchema.safeParse({ status: "skipped", quantity: null }).success,
    ).toBe(true);
  });

  it("不正な status と未知キーを拒否する", () => {
    expect(upsertHabitEntryRequestSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(upsertHabitEntryRequestSchema.safeParse({}).success).toBe(false);
    expect(
      upsertHabitEntryRequestSchema.safeParse({ status: "success", note: "memo" }).success,
    ).toBe(false);
    expect(
      upsertHabitEntryRequestSchema.safeParse({ status: "success", userId: "1" }).success,
    ).toBe(false);
  });

  it("quantity の境界値(0/1000 は可、-1/1001/小数/文字列は不可)", () => {
    const parse = (quantity: unknown) =>
      upsertHabitEntryRequestSchema.safeParse({ status: "success", quantity }).success;
    expect(parse(0)).toBe(true);
    expect(parse(HABIT_ENTRY_MAX_QUANTITY)).toBe(true);
    expect(parse(-1)).toBe(false);
    expect(parse(HABIT_ENTRY_MAX_QUANTITY + 1)).toBe(false);
    expect(parse(1.5)).toBe(false);
    expect(parse("1")).toBe(false);
  });
});

describe("habitEntryDateParamSchema", () => {
  it("実在する暦日のみ受け付ける", () => {
    expect(habitEntryDateParamSchema.safeParse("2026-01-14").success).toBe(true);
    expect(habitEntryDateParamSchema.safeParse("2024-02-29").success).toBe(true);
    expect(habitEntryDateParamSchema.safeParse("2026-02-30").success).toBe(false);
    expect(habitEntryDateParamSchema.safeParse("2026-1-1").success).toBe(false);
    expect(habitEntryDateParamSchema.safeParse("2026-01-14T00:00:00Z").success).toBe(false);
    expect(habitEntryDateParamSchema.safeParse("").success).toBe(false);
  });
});

describe("response schemas", () => {
  const entry = {
    habitId: "00000000-0000-4000-8000-000000000001",
    date: "2026-01-14",
    status: "success",
    quantity: null,
    updatedAt: "2026-01-14T03:00:00.000Z",
  };

  it("habitEntryResponseSchema が応答形を検証できる", () => {
    expect(habitEntryResponseSchema.safeParse(entry).success).toBe(true);
    expect(habitEntryResponseSchema.safeParse({ ...entry, status: "x" }).success).toBe(false);
  });

  it("todayScheduleResponseSchema が応答形を検証できる(entry は null 可)", () => {
    const body = {
      date: "2026-01-14",
      timezone: "Asia/Tokyo",
      earliestDate: "2026-01-07",
      items: [
        {
          habit: {
            id: entry.habitId,
            kind: "build",
            name: "水を飲む",
            cue: "起床直後",
            minimumAction: "コップ1杯",
            replacementAction: null,
          },
          targetCount: 1,
          entry: null,
        },
      ],
    };
    expect(todayScheduleResponseSchema.safeParse(body).success).toBe(true);
  });

  it("earliestDate は必須で、実在する暦日でなければ拒否する", () => {
    const base = { date: "2026-01-14", timezone: "Asia/Tokyo", items: [] };
    expect(todayScheduleResponseSchema.safeParse(base).success).toBe(false);
    expect(
      todayScheduleResponseSchema.safeParse({ ...base, earliestDate: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      todayScheduleResponseSchema.safeParse({ ...base, earliestDate: "2026-01-07" }).success,
    ).toBe(true);
  });
});
