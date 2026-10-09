import type { HabitResponse } from "@habit-app/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/lib/api/api-error";

import { todayInTimezone } from "./date";
import {
  currentSchedule,
  toCreateBody,
  toUpdateBody,
  validateHabitForm,
  valuesFromHabit,
  type HabitFormValues,
} from "./form";
import { summarizeDays } from "./labels";
import {
  CONFLICT_MESSAGE,
  FORM_INVALID_MESSAGE,
  RETROACTIVE_MESSAGE,
  UNEXPECTED_MESSAGE,
  describeHabitError,
} from "./messages";

const base: HabitFormValues = {
  kind: "build",
  name: " 散歩 ",
  purpose: "健康",
  cue: "朝食後",
  minimumAction: "玄関を出る",
  replacementAction: "",
  effectiveFrom: "2026-10-09",
  daysOfWeek: [3, 1, 1, 5],
  targetCount: "2",
};

function habit(overrides: Partial<HabitResponse> = {}): HabitResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "build",
    name: "散歩",
    purpose: "健康",
    cue: "朝食後",
    minimumAction: "玄関を出る",
    replacementAction: null,
    status: "active",
    version: 3,
    scheduleVersions: [
      { effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30", daysOfWeek: [1], targetCount: 1 },
      { effectiveFrom: "2026-10-01", effectiveTo: null, daysOfWeek: [1, 3, 5], targetCount: 2 },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("todayInTimezone", () => {
  it("timezone ごとのローカル日付を返す", () => {
    const instant = new Date("2026-10-09T16:30:00Z");
    expect(todayInTimezone(instant, "Asia/Tokyo")).toBe("2026-10-10");
    expect(todayInTimezone(instant, "America/New_York")).toBe("2026-10-09");
    expect(todayInTimezone(instant, "UTC")).toBe("2026-10-09");
  });

  it("性質: 常に YYYY-MM-DD で、UTC の日付との差は 1 日以内", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01"), max: new Date("2100-01-01"), noInvalidDate: true }),
        fc.constantFrom(
          "Asia/Tokyo",
          "America/Los_Angeles",
          "Pacific/Kiritimati",
          "Pacific/Pago_Pago",
          "UTC",
        ),
        (instant, tz) => {
          const local = todayInTimezone(instant, tz);
          expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const diffDays =
            Math.abs(
              Date.parse(`${local}T00:00:00Z`) -
                Date.parse(`${todayInTimezone(instant, "UTC")}T00:00:00Z`),
            ) / 86_400_000;
          expect(diffDays).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe("summarizeDays", () => {
  it("7 日は毎日、それ以外は日曜始まりの順に並べる", () => {
    expect(summarizeDays([0, 1, 2, 3, 4, 5, 6])).toBe("毎日");
    expect(summarizeDays([5, 1, 3, 1])).toBe("月・水・金");
    expect(summarizeDays([])).toBe("なし");
  });
});

describe("validateHabitForm", () => {
  it("正しい入力は問題なし", () => {
    expect(validateHabitForm(base)).toEqual({});
  });

  it("必須・上限・曜日・回数の境界", () => {
    expect(validateHabitForm({ ...base, name: "  " }).name).toBe("required");
    expect(validateHabitForm({ ...base, name: "a".repeat(100) }).name).toBeUndefined();
    expect(validateHabitForm({ ...base, name: "a".repeat(101) }).name).toBe("too_long");
    expect(validateHabitForm({ ...base, purpose: "a".repeat(501) }).purpose).toBe("too_long");
    expect(validateHabitForm({ ...base, daysOfWeek: [] }).daysOfWeek).toBe("required");
    expect(validateHabitForm({ ...base, targetCount: "0" }).targetCount).toBe("invalid");
    expect(validateHabitForm({ ...base, targetCount: "101" }).targetCount).toBe("invalid");
    expect(validateHabitForm({ ...base, targetCount: "1.5" }).targetCount).toBe("invalid");
    expect(validateHabitForm({ ...base, targetCount: "" }).targetCount).toBe("invalid");
    expect(validateHabitForm({ ...base, effectiveFrom: "" }).effectiveFrom).toBe("required");
  });

  it("reduce は回数を検証せず、代わりの行動は任意(上限のみ)", () => {
    const reduce = { ...base, kind: "reduce" as const, targetCount: "abc" };
    expect(validateHabitForm(reduce).targetCount).toBeUndefined();
    expect(validateHabitForm(reduce).replacementAction).toBeUndefined();
    expect(
      validateHabitForm({ ...reduce, replacementAction: "a".repeat(501) }).replacementAction,
    ).toBe("too_long");
  });
});

describe("toCreateBody", () => {
  it("trim し、曜日を重複除去してソートする", () => {
    const body = toCreateBody(base);
    expect(body.name).toBe("散歩");
    expect(body.schedule).toEqual({
      effectiveFrom: "2026-10-09",
      daysOfWeek: [1, 3, 5],
      targetCount: 2,
    });
    expect(body).not.toHaveProperty("replacementAction");
  });

  it("reduce は回数 1 固定で、代わりの行動があるときだけ送る", () => {
    const reduce = {
      ...base,
      kind: "reduce" as const,
      targetCount: "9",
      replacementAction: " 水を飲む ",
    };
    const body = toCreateBody(reduce);
    expect(body.schedule.targetCount).toBe(1);
    expect(body.replacementAction).toBe("水を飲む");
    expect(toCreateBody({ ...reduce, replacementAction: "  " })).not.toHaveProperty(
      "replacementAction",
    );
  });

  it("build では代わりの行動を送らない", () => {
    expect(toCreateBody({ ...base, replacementAction: "x" })).not.toHaveProperty(
      "replacementAction",
    );
  });
});

describe("currentSchedule / valuesFromHabit", () => {
  it("effectiveTo が null の版を現在の版とし、フォームの初期値にする", () => {
    expect(currentSchedule(habit())?.daysOfWeek).toEqual([1, 3, 5]);
    const values = valuesFromHabit(habit(), "2026-10-09");
    expect(values.daysOfWeek).toEqual([1, 3, 5]);
    expect(values.targetCount).toBe("2");
    expect(values.effectiveFrom).toBe("2026-10-09");
  });
});

describe("toUpdateBody", () => {
  const original = habit();
  const unchanged = valuesFromHabit(original, "2026-10-09");

  it("変更がなければ null(適用開始日だけの変更は変更とみなさない)", () => {
    expect(toUpdateBody(original, unchanged)).toBeNull();
    expect(toUpdateBody(original, { ...unchanged, effectiveFrom: "2030-01-01" })).toBeNull();
  });

  it("変更した項目だけを version 付きで送る", () => {
    expect(toUpdateBody(original, { ...unchanged, name: " 朝の散歩 " })).toEqual({
      version: 3,
      name: "朝の散歩",
    });
  });

  it("曜日または回数が変わったときだけ schedule を送る", () => {
    expect(toUpdateBody(original, { ...unchanged, daysOfWeek: [5, 3, 1, 2] })?.schedule).toEqual({
      effectiveFrom: "2026-10-09",
      daysOfWeek: [1, 2, 3, 5],
      targetCount: 2,
    });
    expect(toUpdateBody(original, { ...unchanged, targetCount: "3" })?.schedule?.targetCount).toBe(
      3,
    );
    // 曜日の順序違いだけは変更ではない。
    expect(toUpdateBody(original, { ...unchanged, daysOfWeek: [5, 1, 3] })).toBeNull();
  });

  it("reduce の代わりの行動: 変更で送り、空にすると null で消去する", () => {
    const reduce = habit({
      kind: "reduce",
      replacementAction: "水を飲む",
      scheduleVersions: [
        { effectiveFrom: "2026-10-01", effectiveTo: null, daysOfWeek: [1], targetCount: 1 },
      ],
    });
    const values = valuesFromHabit(reduce, "2026-10-09");
    expect(
      toUpdateBody(reduce, { ...values, replacementAction: "散歩する" })?.replacementAction,
    ).toBe("散歩する");
    expect(
      toUpdateBody(reduce, { ...values, replacementAction: " " })?.replacementAction,
    ).toBeNull();
    expect(toUpdateBody(reduce, values)).toBeNull();
  });

  it("性質: 曜日の並べ替え・重複は変更にならない", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([1, 3, 5], { minLength: 3, maxLength: 3 }),
        fc.boolean(),
        (shuffled, dup) => {
          const days = dup ? [...shuffled, 3] : shuffled;
          expect(toUpdateBody(original, { ...unchanged, daysOfWeek: days })).toBeNull();
        },
      ),
    );
  });
});

describe("describeHabitError", () => {
  it("409 を競合/アーカイブ済みに分類する", () => {
    expect(describeHabitError(new ApiError({ status: 409, code: "version_conflict" })).kind).toBe(
      "conflict",
    );
    expect(describeHabitError(new ApiError({ status: 409, code: "version_conflict" })).form).toBe(
      CONFLICT_MESSAGE,
    );
    expect(describeHabitError(new ApiError({ status: 409, code: "habit_archived" })).kind).toBe(
      "archived",
    );
  });

  it("404 と不正な path は同じ not_found", () => {
    expect(describeHabitError(new ApiError({ status: 404, code: "habit_not_found" })).kind).toBe(
      "not_found",
    );
    expect(
      describeHabitError(new ApiError({ status: 0, code: CLIENT_ERROR_CODES.invalidRequestPath }))
        .kind,
    ).toBe("not_found");
  });

  it("422 は fieldErrors のキーだけで固定文言を選ぶ", () => {
    const described = describeHabitError(
      new ApiError({
        status: 422,
        code: "validation_failed",
        fieldErrors: { "schedule.effectiveFrom": ["SECRET detail"], name: ["x"] },
      }),
    );
    expect(described.kind).toBe("validation");
    expect(described.fields.effectiveFrom).toBe(RETROACTIVE_MESSAGE);
    expect(described.fields.name).toBe("名前を確認してください。");
    expect(JSON.stringify(described)).not.toContain("SECRET");
    expect(described.form).toBeNull();
  });

  it("422 の schedule(版の重複等)は曜日の項目に固定文言を出す", () => {
    const described = describeHabitError(
      new ApiError({ status: 422, code: "validation_failed", fieldErrors: { schedule: ["x"] } }),
    );
    expect(described.fields.daysOfWeek).toBe("曜日の指定を確認してください。");
    expect(described.form).toBeNull();
  });

  it("422 で未知のキーのみ、_root のみならフォーム全体の固定文言", () => {
    const described = describeHabitError(
      new ApiError({ status: 422, code: "validation_failed", fieldErrors: { _root: ["x"] } }),
    );
    expect(described.form).toBe(FORM_INVALID_MESSAGE);
    expect(described.fields).toEqual({});
  });

  it("network と想定外を分ける", () => {
    expect(
      describeHabitError(new ApiError({ status: 0, code: CLIENT_ERROR_CODES.networkError })).kind,
    ).toBe("network");
    expect(describeHabitError(new ApiError({ status: 500, code: "x" })).form).toBe(
      UNEXPECTED_MESSAGE,
    );
    expect(describeHabitError(new Error("SECRET")).form).toBe(UNEXPECTED_MESSAGE);
  });
});
