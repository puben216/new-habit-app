import { describe, expect, it } from "vitest";
import {
  HABIT_NAME_MAX_LENGTH,
  HABIT_TEXT_MAX_LENGTH,
  archiveHabitRequestSchema,
  createHabitRequestSchema,
  habitResponseSchema,
  listHabitsQuerySchema,
  updateHabitRequestSchema,
} from "./habits";

const validCreate = {
  kind: "build",
  name: "朝に本を読む",
  purpose: "学習を日常化する",
  cue: "朝食後",
  minimumAction: "1ページ読む",
  schedule: { effectiveFrom: "2026-10-01", daysOfWeek: [1, 2, 3, 4, 5] },
};

describe("createHabitRequestSchema(HAPI-001, HAPI-INV-005)", () => {
  it("有効な入力を受け付け、targetCountの既定値は1", () => {
    const result = createHabitRequestSchema.safeParse(validCreate);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.schedule.targetCount).toBe(1);
  });

  it("name/本文の上限の境界値(100/101、500/501文字)", () => {
    const ok = createHabitRequestSchema.safeParse({
      ...validCreate,
      name: "a".repeat(HABIT_NAME_MAX_LENGTH),
      purpose: "a".repeat(HABIT_TEXT_MAX_LENGTH),
    });
    expect(ok.success).toBe(true);
    expect(
      createHabitRequestSchema.safeParse({
        ...validCreate,
        name: "a".repeat(HABIT_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      createHabitRequestSchema.safeParse({
        ...validCreate,
        cue: "a".repeat(HABIT_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it.each(["a\nb", "a\tb", "a\u0000b", "a\u007fb"])("制御文字を拒否する(%j)", (name) => {
    expect(createHabitRequestSchema.safeParse({ ...validCreate, name }).success).toBe(false);
  });

  it("未知キー(userId/id/effectiveTo/localTime)を拒否する", () => {
    expect(createHabitRequestSchema.safeParse({ ...validCreate, userId: "1" }).success).toBe(false);
    expect(createHabitRequestSchema.safeParse({ ...validCreate, id: "x" }).success).toBe(false);
    expect(
      createHabitRequestSchema.safeParse({
        ...validCreate,
        schedule: { ...validCreate.schedule, effectiveTo: "2026-12-31" },
      }).success,
    ).toBe(false);
    expect(
      createHabitRequestSchema.safeParse({
        ...validCreate,
        schedule: { ...validCreate.schedule, localTime: "07:30" },
      }).success,
    ).toBe(false);
  });

  it("不正なkind、存在しない暦日、daysOfWeekの範囲外/8要素を拒否する", () => {
    expect(createHabitRequestSchema.safeParse({ ...validCreate, kind: "other" }).success).toBe(
      false,
    );
    expect(
      createHabitRequestSchema.safeParse({
        ...validCreate,
        schedule: { ...validCreate.schedule, effectiveFrom: "2026-02-30" },
      }).success,
    ).toBe(false);
    expect(
      createHabitRequestSchema.safeParse({
        ...validCreate,
        schedule: { ...validCreate.schedule, daysOfWeek: [7] },
      }).success,
    ).toBe(false);
    expect(
      createHabitRequestSchema.safeParse({
        ...validCreate,
        schedule: { ...validCreate.schedule, daysOfWeek: [0, 1, 2, 3, 4, 5, 6, 0] },
      }).success,
    ).toBe(false);
  });

  it("replacementActionはnullを許可する", () => {
    expect(
      createHabitRequestSchema.safeParse({ ...validCreate, replacementAction: null }).success,
    ).toBe(true);
  });
});

describe("updateHabitRequestSchema(HAPI-004)", () => {
  it("versionと1つ以上の変更項目を受け付ける", () => {
    expect(updateHabitRequestSchema.safeParse({ version: 1, name: "新しい名前" }).success).toBe(
      true,
    );
    expect(
      updateHabitRequestSchema.safeParse({ version: 2, replacementAction: null }).success,
    ).toBe(true);
  });

  it("versionのみ(変更項目なし)を拒否する", () => {
    expect(updateHabitRequestSchema.safeParse({ version: 1 }).success).toBe(false);
  });

  it("version欠落・0・小数を拒否する", () => {
    expect(updateHabitRequestSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(updateHabitRequestSchema.safeParse({ version: 0, name: "x" }).success).toBe(false);
    expect(updateHabitRequestSchema.safeParse({ version: 1.5, name: "x" }).success).toBe(false);
  });

  it("kindの変更を拒否する(作成後変更不可)", () => {
    expect(updateHabitRequestSchema.safeParse({ version: 1, kind: "reduce" }).success).toBe(false);
  });
});

describe("archiveHabitRequestSchema(HAPI-005)", () => {
  it("versionのみを受け付ける", () => {
    expect(archiveHabitRequestSchema.safeParse({ version: 3 }).success).toBe(true);
    expect(archiveHabitRequestSchema.safeParse({ version: 3, name: "x" }).success).toBe(false);
  });
});

describe("listHabitsQuerySchema(HAPI-002)", () => {
  it("既定値はstatus=active、limit=20", () => {
    expect(listHabitsQuerySchema.parse({})).toEqual({ status: "active", limit: 20 });
  });

  it("文字列のlimitを数値へ変換し、範囲(1〜100)を検査する", () => {
    expect(listHabitsQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    expect(listHabitsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listHabitsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(listHabitsQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });

  it("不正なstatus・未知のクエリ・長すぎるcursorを拒否する", () => {
    expect(listHabitsQuerySchema.safeParse({ status: "all" }).success).toBe(false);
    expect(listHabitsQuerySchema.safeParse({ userId: "1" }).success).toBe(false);
    expect(listHabitsQuerySchema.safeParse({ cursor: "a".repeat(513) }).success).toBe(false);
  });
});

describe("habitResponseSchema", () => {
  it("応答の形を検証できる", () => {
    const result = habitResponseSchema.safeParse({
      id: "5d1b6d4e-6b1c-4a0e-9e0e-7a0f8d5b8c11",
      kind: "build",
      name: "n",
      purpose: "p",
      cue: "c",
      minimumAction: "m",
      replacementAction: null,
      status: "active",
      version: 1,
      scheduleVersions: [
        { effectiveFrom: "2026-10-01", effectiveTo: null, daysOfWeek: [1], targetCount: 1 },
      ],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});
