import { describe, expect, it } from "vitest";
import { isLocale } from "./locale";
import { isWeekStartsOn } from "./week-starts-on";

describe("isLocale(PROF-005)", () => {
  it("jaとenのみ許可する", () => {
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale("JA")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});

describe("isWeekStartsOn(PROF-005)", () => {
  it("0〜6の整数のみ許可する", () => {
    for (const ok of [0, 1, 2, 3, 4, 5, 6]) expect(isWeekStartsOn(ok)).toBe(true);
    for (const bad of [-1, 7, 1.5, NaN, "1", null, undefined]) {
      expect(isWeekStartsOn(bad)).toBe(false);
    }
  });
});
