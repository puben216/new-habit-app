import { describe, expect, it } from "vitest";
import { addCalendarDays, dayOfWeekOf } from "./calendar-date";
import { InvalidScheduleCalculationInputError, OverlappingScheduleVersionError } from "./errors";
import {
  MAX_OCCURRENCE_RANGE_DAYS,
  generateOccurrences,
  resolveScheduleForDate,
  scheduledOccurrenceOn,
} from "./occurrence";
import { createScheduleVersion } from "./schedule-version";
import type { ScheduleVersion } from "./schedule-version";

function version(
  effectiveFrom: string,
  effectiveTo: string | null,
  daysOfWeek: number[],
  targetCount = 1,
): ScheduleVersion {
  return createScheduleVersion("build", { effectiveFrom, effectiveTo, daysOfWeek, targetCount });
}

describe("resolveScheduleForDate", () => {
  const v = version("2026-01-10", "2026-01-20", [1]);

  it("有効期間の両端を含めて版を返す", () => {
    expect(resolveScheduleForDate([v], "2026-01-10")).toBe(v);
    expect(resolveScheduleForDate([v], "2026-01-15")).toBe(v);
    expect(resolveScheduleForDate([v], "2026-01-20")).toBe(v);
  });

  it("期間外は null を返す", () => {
    expect(resolveScheduleForDate([v], "2026-01-09")).toBeNull();
    expect(resolveScheduleForDate([v], "2026-01-21")).toBeNull();
    expect(resolveScheduleForDate([], "2026-01-15")).toBeNull();
  });

  it("effectiveTo が null なら無期限", () => {
    const open = version("2026-01-10", null, [1]);
    expect(resolveScheduleForDate([open], "2030-12-31")).toBe(open);
  });

  it("有効期間が重複する版が複数該当すると例外にする", () => {
    const a = version("2026-01-01", null, [1]);
    const b = version("2026-02-01", null, [2]);
    expect(() => resolveScheduleForDate([a, b], "2026-02-10")).toThrow(
      OverlappingScheduleVersionError,
    );
  });

  it("実在しない暦日を拒否する", () => {
    expect(() => resolveScheduleForDate([v], "2026-02-30")).toThrow(
      InvalidScheduleCalculationInputError,
    );
  });
});

describe("scheduledOccurrenceOn", () => {
  const v = version("2026-01-01", null, [1, 3, 5], 2);

  it("対象曜日には targetCount と適用版の effectiveFrom を返す", () => {
    expect(scheduledOccurrenceOn([v], "2026-01-05")).toEqual({
      date: "2026-01-05",
      targetCount: 2,
      effectiveFrom: "2026-01-01",
    });
  });

  it("非対象曜日・版なしは null を返す", () => {
    expect(scheduledOccurrenceOn([v], "2026-01-06")).toBeNull();
    expect(scheduledOccurrenceOn([v], "2025-12-29")).toBeNull();
  });

  it("版の切替日は新版、旧版の最終日は旧版で判定する", () => {
    const a = version("2026-01-01", "2026-01-31", [6], 1); // 1/31 は土曜
    const b = version("2026-02-01", null, [0], 3); // 2/1 は日曜
    expect(scheduledOccurrenceOn([a, b], "2026-01-31")).toMatchObject({ targetCount: 1 });
    expect(scheduledOccurrenceOn([a, b], "2026-02-01")).toMatchObject({ targetCount: 3 });
  });
});

describe("generateOccurrences", () => {
  it("対象曜日だけを昇順に返す", () => {
    const v = version("2026-01-01", null, [1, 3, 5]);
    const result = generateOccurrences([v], { from: "2026-01-05", to: "2026-01-11" });
    expect(result.map((o) => o.date)).toEqual(["2026-01-05", "2026-01-07", "2026-01-09"]);
  });

  it("両端を含む", () => {
    const v = version("2026-01-01", null, [0, 1, 2, 3, 4, 5, 6]);
    const result = generateOccurrences([v], { from: "2026-01-01", to: "2026-01-03" });
    expect(result.map((o) => o.date)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  it("版の切替をまたぐと、それぞれの版の曜日と targetCount で返す", () => {
    const a = version("2026-01-01", "2026-01-31", [1], 1);
    const b = version("2026-02-01", null, [0], 3);
    const result = generateOccurrences([a, b], { from: "2026-01-31", to: "2026-02-02" });
    expect(result).toEqual([{ date: "2026-02-01", targetCount: 3, effectiveFrom: "2026-02-01" }]);
  });

  it("effectiveFrom より前の日は含まない", () => {
    const v = version("2026-03-01", null, [0, 1, 2, 3, 4, 5, 6]);
    const result = generateOccurrences([v], { from: "2026-02-27", to: "2026-03-02" });
    expect(result.map((o) => o.date)).toEqual(["2026-03-01", "2026-03-02"]);
  });

  it("from が to より後なら空配列、版が空でも空配列", () => {
    const v = version("2026-01-01", null, [1]);
    expect(generateOccurrences([v], { from: "2026-01-10", to: "2026-01-09" })).toEqual([]);
    expect(generateOccurrences([], { from: "2026-01-01", to: "2026-01-31" })).toEqual([]);
  });

  it("上限日数ちょうどは受理し、超過は拒否する", () => {
    const v = version("2020-01-01", null, [0, 1, 2, 3, 4, 5, 6]);
    const from = "2026-01-01";
    const ok = generateOccurrences([v], {
      from,
      to: addCalendarDays(from, MAX_OCCURRENCE_RANGE_DAYS - 1),
    });
    expect(ok).toHaveLength(MAX_OCCURRENCE_RANGE_DAYS);
    expect(() =>
      generateOccurrences([v], { from, to: addCalendarDays(from, MAX_OCCURRENCE_RANGE_DAYS) }),
    ).toThrow(InvalidScheduleCalculationInputError);
  });

  it("極端に長い範囲でも走査せず即座に拒否する", () => {
    expect(() => generateOccurrences([], { from: "0001-01-01", to: "9999-12-31" })).toThrow(
      InvalidScheduleCalculationInputError,
    );
  });

  it("実在しない暦日を拒否する", () => {
    expect(() => generateOccurrences([], { from: "2026-02-30", to: "2026-03-01" })).toThrow(
      InvalidScheduleCalculationInputError,
    );
  });

  it("DST 切替日を含む範囲でも 1 暦日につき高々 1 件で、日数が欠けない", () => {
    const v = version("2026-01-01", null, [0, 1, 2, 3, 4, 5, 6]);
    const result = generateOccurrences([v], { from: "2026-03-07", to: "2026-03-10" });
    expect(result.map((o) => o.date)).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
  });

  it("返却値が不変である", () => {
    const v = version("2026-01-01", null, [1]);
    const result = generateOccurrences([v], { from: "2026-01-01", to: "2026-01-31" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  describe("性質テスト(シード固定の疑似乱数)", () => {
    // mulberry32。依存を追加せず再現可能な乱数列を得る。
    function rng(seed: number): () => number {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it("全日走査(scheduledOccurrenceOn)と一致し、昇順・重複なし・曜日整合を満たす", () => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const rand = rng(seed);
        const pickInt = (max: number): number => Math.floor(rand() * max);

        // 連続する互いに重複しない版を 1〜4 個作る
        const versions: ScheduleVersion[] = [];
        let cursor = addCalendarDays("2024-01-01", pickInt(400));
        const count = 1 + pickInt(4);
        for (let i = 0; i < count; i += 1) {
          const days = [0, 1, 2, 3, 4, 5, 6].filter(() => rand() < 0.5);
          const daysOfWeek = days.length > 0 ? days : [pickInt(7)];
          const isLast = i === count - 1;
          const to = isLast && rand() < 0.5 ? null : addCalendarDays(cursor, pickInt(120));
          versions.push(version(cursor, to, daysOfWeek, 1 + pickInt(5)));
          if (to === null) break;
          cursor = addCalendarDays(to, 1 + pickInt(10));
        }

        const from = addCalendarDays("2024-01-01", pickInt(800));
        const span = pickInt(MAX_OCCURRENCE_RANGE_DAYS);
        const to = addCalendarDays(from, span);
        const generated = generateOccurrences(versions, { from, to });

        const expected = [];
        for (let i = 0; i <= span; i += 1) {
          const o = scheduledOccurrenceOn(versions, addCalendarDays(from, i));
          if (o !== null) expected.push(o);
        }
        expect(generated).toEqual(expected);

        const dates = generated.map((o) => o.date);
        expect(new Set(dates).size).toBe(dates.length);
        expect([...dates].sort()).toEqual(dates);
        for (const o of generated) {
          const applied = versions.find((v) => v.effectiveFrom === o.effectiveFrom);
          expect(applied?.daysOfWeek).toContain(dayOfWeekOf(o.date));
          expect(o.date >= from && o.date <= to).toBe(true);
        }
      }
    });
  });
});
