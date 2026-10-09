import { describe, expect, it } from "vitest";
import {
  WEEKLY_REVIEW_REFLECTION_MAX_LENGTH,
  createWeeklyReviewRequestSchema,
  listWeeklyReviewsQuerySchema,
  updateWeeklyReviewRequestSchema,
  weeklyReviewIdParamSchema,
  weeklyReviewListResponseSchema,
  weeklyReviewResponseSchema,
  weeklyReviewSummarySchema,
} from "./weekly-review";

const HABIT_ID = "5b0e4c1e-8a46-4a53-9d0c-0e1f6d7c9a10";

const outcomes: {
  scheduled: number;
  success: number;
  missed: number;
  skipped: number;
  pending: number;
  successRate: number | null;
} = {
  scheduled: 7,
  success: 4,
  missed: 2,
  skipped: 1,
  pending: 0,
  successRate: 4 / 6,
};

function summary() {
  return {
    schemaVersion: 1,
    weekStart: "2026-01-05",
    weekEnd: "2026-01-11",
    overall: { ...outcomes },
    habits: [{ ...outcomes, habitId: HABIT_ID, kind: "build", name: "水を飲む" }],
    checkIn: {
      days: 2,
      averageMood: 3 as number | null,
      averageDifficulty: null as number | null,
    },
  };
}

function review() {
  return {
    id: HABIT_ID,
    weekStart: "2026-01-05",
    weekEnd: "2026-01-11",
    timezone: "Asia/Tokyo",
    status: "draft",
    summary: summary(),
    reflection: null,
    completedAt: null,
    createdAt: "2026-01-14T00:00:00.000Z",
    updatedAt: "2026-01-14T00:00:00.000Z",
  };
}

describe("createWeeklyReviewRequestSchema", () => {
  it("実在する暦日の weekStart を受け付ける", () => {
    expect(createWeeklyReviewRequestSchema.safeParse({ weekStart: "2026-01-05" }).success).toBe(
      true,
    );
  });

  it.each([
    {},
    { weekStart: "2026-02-30" },
    { weekStart: "2026-1-5" },
    { weekStart: "2026-01-05T00:00:00Z" },
    { weekStart: 20260105 },
    { weekStart: null },
    { weekStart: "2026-01-05", userId: "1" },
  ])("不正な入力は拒否する: %j", (body) => {
    expect(createWeeklyReviewRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("updateWeeklyReviewRequestSchema", () => {
  it("reflection のみ・status のみ・両方を受け付ける", () => {
    expect(updateWeeklyReviewRequestSchema.safeParse({ reflection: "よく続いた" }).success).toBe(
      true,
    );
    expect(updateWeeklyReviewRequestSchema.safeParse({ reflection: null }).success).toBe(true);
    expect(updateWeeklyReviewRequestSchema.safeParse({ status: "completed" }).success).toBe(true);
    expect(
      updateWeeklyReviewRequestSchema.safeParse({ reflection: "x", status: "completed" }).success,
    ).toBe(true);
  });

  it("空 body・status: undefined のみは拒否する(少なくとも 1 項目)", () => {
    expect(updateWeeklyReviewRequestSchema.safeParse({}).success).toBe(false);
    expect(updateWeeklyReviewRequestSchema.safeParse({ status: undefined }).success).toBe(false);
  });

  it.each([
    { status: "draft" },
    { status: "COMPLETED" },
    { status: null },
    { reflection: 1 },
    { reflection: { text: "x" } },
    { reflection: "x", extra: true },
    { weekStart: "2026-01-05" },
    { summary: {} },
  ])("不正な入力・変更不可の項目は拒否する: %j", (body) => {
    expect(updateWeeklyReviewRequestSchema.safeParse(body).success).toBe(false);
  });

  it("reflection は 1000 文字ちょうどまで、1001 文字は拒否する", () => {
    const max = "あ".repeat(WEEKLY_REVIEW_REFLECTION_MAX_LENGTH);
    expect(updateWeeklyReviewRequestSchema.safeParse({ reflection: max }).success).toBe(true);
    expect(updateWeeklyReviewRequestSchema.safeParse({ reflection: `${max}あ` }).success).toBe(
      false,
    );
  });

  it("改行・タブは許可し、NUL・ESC・DEL などの制御文字は拒否する", () => {
    expect(updateWeeklyReviewRequestSchema.safeParse({ reflection: "a\nb\tc" }).success).toBe(true);
    for (const char of ["\u0000", "\u001b", "\u007f", "\r", "\u0008"]) {
      expect(updateWeeklyReviewRequestSchema.safeParse({ reflection: `a${char}b` }).success).toBe(
        false,
      );
    }
  });
});

describe("listWeeklyReviewsQuerySchema", () => {
  it("既定の limit は 20、文字列の数値を変換する", () => {
    expect(listWeeklyReviewsQuerySchema.parse({}).limit).toBe(20);
    expect(listWeeklyReviewsQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it.each([{ limit: "0" }, { limit: "51" }, { limit: "1.5" }, { limit: "abc" }, { cursor: "" }])(
    "範囲外・不正な query は拒否する: %j",
    (query) => {
      expect(listWeeklyReviewsQuerySchema.safeParse(query).success).toBe(false);
    },
  );

  it("長すぎる cursor・未知のキーは拒否する", () => {
    expect(listWeeklyReviewsQuerySchema.safeParse({ cursor: "a".repeat(129) }).success).toBe(false);
    expect(listWeeklyReviewsQuerySchema.safeParse({ status: "draft" }).success).toBe(false);
  });
});

describe("weeklyReviewIdParamSchema", () => {
  it("UUID のみ受け付ける", () => {
    expect(weeklyReviewIdParamSchema.safeParse(HABIT_ID).success).toBe(true);
    for (const value of ["1", "abc", "", "5b0e4c1e-8a46-4a53-9d0c", `${HABIT_ID}x`]) {
      expect(weeklyReviewIdParamSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("weeklyReviewSummarySchema / weeklyReviewResponseSchema", () => {
  it("正しいスナップショットと応答を受け付ける", () => {
    expect(weeklyReviewSummarySchema.safeParse(summary()).success).toBe(true);
    expect(weeklyReviewResponseSchema.safeParse(review()).success).toBe(true);
    expect(
      weeklyReviewListResponseSchema.safeParse({ items: [review()], nextCursor: null }).success,
    ).toBe(true);
  });

  it("successRate と平均は null を許可し、範囲外は拒否する", () => {
    const empty = summary();
    empty.overall.successRate = null;
    empty.checkIn.averageMood = null;
    expect(weeklyReviewSummarySchema.safeParse(empty).success).toBe(true);

    for (const mutate of [
      (s: ReturnType<typeof summary>) => (s.overall.successRate = 1.01),
      (s: ReturnType<typeof summary>) => (s.overall.successRate = -0.01),
      (s: ReturnType<typeof summary>) => (s.overall.success = -1),
      (s: ReturnType<typeof summary>) => (s.overall.scheduled = 1.5),
      (s: ReturnType<typeof summary>) => (s.checkIn.days = 8),
      (s: ReturnType<typeof summary>) => (s.checkIn.averageMood = 0.9),
      (s: ReturnType<typeof summary>) => (s.checkIn.averageDifficulty = 5.1),
      (s: ReturnType<typeof summary>) => (s.schemaVersion = 2),
      (s: ReturnType<typeof summary>) => (s.weekEnd = "2026-02-30"),
    ]) {
      const broken = summary();
      mutate(broken);
      expect(weeklyReviewSummarySchema.safeParse(broken).success).toBe(false);
    }
  });

  it("スナップショットの未知キー(自由記述の混入など)・不正な習慣 ID/種別は拒否する", () => {
    const withExtra = { ...summary(), note: "メモ" };
    expect(weeklyReviewSummarySchema.safeParse(withExtra).success).toBe(false);

    const habitWithPurpose = summary();
    Object.assign(habitWithPurpose.habits[0] ?? {}, { purpose: "健康" });
    expect(weeklyReviewSummarySchema.safeParse(habitWithPurpose).success).toBe(false);

    const badId = summary();
    if (badId.habits[0] !== undefined) badId.habits[0].habitId = "1";
    expect(weeklyReviewSummarySchema.safeParse(badId).success).toBe(false);

    const badKind = summary();
    if (badKind.habits[0] !== undefined) badKind.habits[0].kind = "other";
    expect(weeklyReviewSummarySchema.safeParse(badKind).success).toBe(false);
  });

  it("status は draft/completed のみ、日時は ISO 形式", () => {
    expect(weeklyReviewResponseSchema.safeParse({ ...review(), status: "done" }).success).toBe(
      false,
    );
    expect(
      weeklyReviewResponseSchema.safeParse({ ...review(), completedAt: "2026-01-14" }).success,
    ).toBe(false);
  });
});
