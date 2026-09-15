import { describe, expect, it } from "vitest";
import { assertHabitKind, isHabitKind } from "./habit-kind";
import { InvalidHabitKindError } from "./errors";

describe("isHabitKind", () => {
  it("build/reduceを有効なHabitKindとして受理する", () => {
    expect(isHabitKind("build")).toBe(true);
    expect(isHabitKind("reduce")).toBe(true);
  });

  it("build/reduce以外を拒否する", () => {
    expect(isHabitKind("maintain")).toBe(false);
    expect(isHabitKind("")).toBe(false);
    expect(isHabitKind(123)).toBe(false);
    expect(isHabitKind(undefined)).toBe(false);
  });
});

describe("assertHabitKind", () => {
  it("不正な値に対してInvalidHabitKindErrorを投げる", () => {
    expect(() => assertHabitKind("unknown")).toThrow(InvalidHabitKindError);
  });

  it("有効な値では例外を投げない", () => {
    expect(() => assertHabitKind("build")).not.toThrow();
  });
});
