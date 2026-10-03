import { describe, expect, it } from "vitest";
import { HABIT_ENTRY_MAX_QUANTITY, resolveHabitEntry } from "./habit-entry";
import { InvalidHabitEntryError } from "./errors";

describe("resolveHabitEntry: build", () => {
  it("success は quantity 省略時に targetCount を補う", () => {
    expect(resolveHabitEntry("build", 1, { status: "success" })).toEqual({
      status: "success",
      quantity: 1,
    });
    expect(resolveHabitEntry("build", 3, { status: "success" })).toEqual({
      status: "success",
      quantity: 3,
    });
  });

  it("success は targetCount 以上の quantity を受理する(超過も可)", () => {
    expect(resolveHabitEntry("build", 3, { status: "success", quantity: 3 }).quantity).toBe(3);
    expect(resolveHabitEntry("build", 3, { status: "success", quantity: 5 }).quantity).toBe(5);
    expect(
      resolveHabitEntry("build", 1, { status: "success", quantity: HABIT_ENTRY_MAX_QUANTITY })
        .quantity,
    ).toBe(HABIT_ENTRY_MAX_QUANTITY);
  });

  it("success で quantity が targetCount 未満なら拒否する", () => {
    expect(() => resolveHabitEntry("build", 3, { status: "success", quantity: 2 })).toThrow(
      InvalidHabitEntryError,
    );
    expect(() => resolveHabitEntry("build", 1, { status: "success", quantity: 0 })).toThrow(
      InvalidHabitEntryError,
    );
  });

  it("missed は quantity 省略時に 0 を補い、途中経過(目標未満)を受理する", () => {
    expect(resolveHabitEntry("build", 3, { status: "missed" })).toEqual({
      status: "missed",
      quantity: 0,
    });
    expect(resolveHabitEntry("build", 3, { status: "missed", quantity: 2 }).quantity).toBe(2);
  });

  it("missed で quantity が targetCount 以上なら拒否する", () => {
    expect(() => resolveHabitEntry("build", 3, { status: "missed", quantity: 3 })).toThrow(
      InvalidHabitEntryError,
    );
    expect(() => resolveHabitEntry("build", 1, { status: "missed", quantity: 1 })).toThrow(
      InvalidHabitEntryError,
    );
  });

  it("skipped は quantity を持たない", () => {
    expect(resolveHabitEntry("build", 3, { status: "skipped" })).toEqual({
      status: "skipped",
      quantity: null,
    });
    expect(() => resolveHabitEntry("build", 3, { status: "skipped", quantity: 0 })).toThrow(
      InvalidHabitEntryError,
    );
  });

  it("負数・小数・上限超過・非有限値の quantity を拒否する", () => {
    for (const quantity of [-1, 1.5, HABIT_ENTRY_MAX_QUANTITY + 1, Number.NaN, Infinity]) {
      expect(() => resolveHabitEntry("build", 1, { status: "success", quantity })).toThrow(
        InvalidHabitEntryError,
      );
    }
  });

  it("success と isTargetMet の判定が一致する(境界値)", () => {
    for (const targetCount of [1, 2, 5]) {
      for (let quantity = 0; quantity <= targetCount + 1; quantity += 1) {
        const asSuccess = () =>
          resolveHabitEntry("build", targetCount, { status: "success", quantity });
        const asMissed = () =>
          resolveHabitEntry("build", targetCount, { status: "missed", quantity });
        if (quantity >= targetCount) {
          expect(asSuccess).not.toThrow();
          expect(asMissed).toThrow(InvalidHabitEntryError);
        } else {
          expect(asSuccess).toThrow(InvalidHabitEntryError);
          expect(asMissed).not.toThrow();
        }
      }
    }
  });

  it("エラーは問題の項目名を持つ", () => {
    try {
      resolveHabitEntry("build", 3, { status: "success", quantity: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidHabitEntryError);
      expect((error as InvalidHabitEntryError).field).toBe("quantity");
    }
  });
});

describe("resolveHabitEntry: reduce", () => {
  it("すべての status を quantity なしで受理する", () => {
    for (const status of ["success", "missed", "skipped"] as const) {
      expect(resolveHabitEntry("reduce", 1, { status })).toEqual({ status, quantity: null });
    }
  });

  it("quantity の指定を拒否する(0 も拒否)", () => {
    expect(() => resolveHabitEntry("reduce", 1, { status: "success", quantity: 1 })).toThrow(
      InvalidHabitEntryError,
    );
    expect(() => resolveHabitEntry("reduce", 1, { status: "missed", quantity: 0 })).toThrow(
      InvalidHabitEntryError,
    );
  });

  it("quantity: null は未指定として扱う", () => {
    expect(
      resolveHabitEntry("reduce", 1, { status: "success", quantity: null }).quantity,
    ).toBeNull();
  });
});
