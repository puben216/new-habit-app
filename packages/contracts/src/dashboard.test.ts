import { describe, expect, it } from "vitest";
import { dashboardResponseSchema } from "./dashboard";

const window = {
  from: "2026-01-08",
  to: "2026-01-14",
  scheduled: 7,
  success: 4,
  missed: 2,
  skipped: 0,
  pending: 1,
  successRate: 4 / 6,
};

const valid = {
  date: "2026-01-14",
  timezone: "Asia/Tokyo",
  overall: { last7Days: window, last30Days: { ...window, from: "2025-12-16" } },
  habits: [
    {
      habit: { id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", kind: "build", name: "水を飲む" },
      currentStreak: 3,
      longestStreak: 10,
      last7Days: window,
      last30Days: window,
    },
  ],
};

describe("dashboardResponseSchema(STAT-001)", () => {
  it("正しい応答を受け付ける(習慣なしの空状態を含む)", () => {
    expect(dashboardResponseSchema.safeParse(valid).success).toBe(true);
    expect(dashboardResponseSchema.safeParse({ ...valid, habits: [] }).success).toBe(true);
  });

  it("successRate は 0〜1 または null。範囲外・文字列は拒否する", () => {
    const withRate = (successRate: unknown) =>
      dashboardResponseSchema.safeParse({
        ...valid,
        overall: { ...valid.overall, last7Days: { ...window, successRate } },
      }).success;
    expect(withRate(null)).toBe(true);
    expect(withRate(0)).toBe(true);
    expect(withRate(1)).toBe(true);
    expect(withRate(1.01)).toBe(false);
    expect(withRate(-0.1)).toBe(false);
    expect(withRate("0.5")).toBe(false);
  });

  it("件数は 0 以上の整数", () => {
    const withCount = (success: unknown) =>
      dashboardResponseSchema.safeParse({
        ...valid,
        overall: { ...valid.overall, last7Days: { ...window, success } },
      }).success;
    expect(withCount(0)).toBe(true);
    expect(withCount(-1)).toBe(false);
    expect(withCount(1.5)).toBe(false);
  });

  it("日付は実在する暦日、習慣 ID は UUID", () => {
    expect(dashboardResponseSchema.safeParse({ ...valid, date: "2026-02-30" }).success).toBe(false);
    expect(
      dashboardResponseSchema.safeParse({
        ...valid,
        habits: [{ ...valid.habits[0], habit: { ...valid.habits[0]?.habit, id: "1" } }],
      }).success,
    ).toBe(false);
  });
});
