import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatPeriod, formatRate, rateMeterValue, streakText } from "./format";

describe("formatRate", () => {
  it("null は 0% と区別する", () => {
    expect(formatRate(null)).toBe("まだ集計できません");
    expect(formatRate(0)).toBe("0%");
  });

  it("通常の丸めと境界", () => {
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(0.5)).toBe("50%");
    expect(formatRate(2 / 6)).toBe("33%");
    expect(formatRate(3 / 7)).toBe("43%");
    expect(formatRate(0.995)).toBe("99%");
    expect(formatRate(0.9999)).toBe("99%");
    expect(formatRate(0.004)).toBe("1%");
    expect(formatRate(0.0001)).toBe("1%");
  });

  it("性質: 100% は 1 のときだけ、0% は 0 のときだけ", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (rate) => {
        const text = formatRate(rate);
        expect(text === "100%").toBe(rate === 1);
        expect(text === "0%").toBe(rate === 0);
      }),
    );
  });

  it("性質: 単調非減少で 0〜100 の整数%", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          const value = (rate: number) => Number.parseInt(formatRate(rate), 10);
          expect(value(low)).toBeLessThanOrEqual(value(high));
          expect(formatRate(low)).toMatch(/^(100|[1-9]?\d)%$/);
        },
      ),
    );
  });
});

describe("rateMeterValue", () => {
  it("null は 0、範囲外は 0〜100 に収める", () => {
    expect(rateMeterValue(null)).toBe(0);
    expect(rateMeterValue(0.426)).toBe(43);
    expect(rateMeterValue(1.5)).toBe(100);
    expect(rateMeterValue(-1)).toBe(0);
  });
});

describe("formatPeriod / streakText", () => {
  it("期間を月/日で表し、ストリークは控えめな文言", () => {
    expect(formatPeriod("2026-10-04", "2026-10-10")).toBe("10/4〜10/10");
    expect(formatPeriod("2025-12-05", "2026-01-03")).toBe("12/5〜1/3");
    expect(streakText(2, 5)).toBe("現在 2 回連続(最長 5 回)");
  });
});
