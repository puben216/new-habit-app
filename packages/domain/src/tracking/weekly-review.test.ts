import { describe, expect, it } from "vitest";
import { addCalendarDays } from "../habits/calendar-date";
import { createScheduleVersion } from "../habits/schedule-version";
import type { ScheduleVersion } from "../habits/schedule-version";
import type { HabitEntryStatus } from "./habit-entry";
import { InvalidWeeklyReviewError } from "./errors";
import type { StatisticsEntry } from "./statistics";
import {
  REVIEW_MAX_WEEKS_BACK,
  WEEKLY_REVIEW_REFLECTION_MAX_LENGTH,
  buildWeeklyReviewSummary,
  checkReviewableWeek,
  normalizeWeeklyReflection,
  weekEndOf,
} from "./weekly-review";
import type { WeeklyReviewHabitInput } from "./weekly-review";

// 2026-01-14 は水曜日。週(月曜始まり)は 2026-01-05(月)〜2026-01-11(日)。
const TODAY = "2026-01-14";
const WEEK_START = "2026-01-05";
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

function schedule(daysOfWeek: readonly number[] = EVERY_DAY, effectiveFrom = "2020-01-01") {
  return [createScheduleVersion("build", { effectiveFrom, daysOfWeek, targetCount: 1 })];
}

function habit(
  id: string,
  entries: StatisticsEntry[],
  scheduleVersions: readonly ScheduleVersion[] = schedule(),
): WeeklyReviewHabitInput {
  return { habitId: id, kind: "build", name: `習慣${id}`, scheduleVersions, entries };
}

function onDay(offset: number, status: HabitEntryStatus): StatisticsEntry {
  return { date: addCalendarDays(WEEK_START, offset), status };
}

describe("weekEndOf", () => {
  it("開始日の 6 日後を返す(月・年の境界を含む)", () => {
    expect(weekEndOf("2026-01-05")).toBe("2026-01-11");
    expect(weekEndOf("2025-12-29")).toBe("2026-01-04");
    expect(weekEndOf("2024-02-26")).toBe("2024-03-03");
  });
});

describe("checkReviewableWeek", () => {
  const base = { today: TODAY, weekStartsOn: 1 };

  it("終了済みの週の開始日は作成できる", () => {
    expect(checkReviewableWeek({ ...base, weekStart: WEEK_START })).toEqual({ ok: true });
  });

  it("週の開始日でない日付・実在しない日付・形式不正は not_week_start", () => {
    for (const weekStart of ["2026-01-06", "2026-01-04", "2026-02-30", "2026-1-5", "", "abc"]) {
      expect(checkReviewableWeek({ ...base, weekStart })).toEqual({
        ok: false,
        reason: "not_week_start",
      });
    }
  });

  it("weekStartsOn に従う(日曜始まりなら日曜が開始日、月曜は不可)", () => {
    expect(checkReviewableWeek({ today: TODAY, weekStartsOn: 0, weekStart: "2026-01-04" })).toEqual(
      { ok: true },
    );
    expect(checkReviewableWeek({ today: TODAY, weekStartsOn: 0, weekStart: WEEK_START })).toEqual({
      ok: false,
      reason: "not_week_start",
    });
  });

  it("進行中の週・未来の週は not_ended", () => {
    for (const weekStart of ["2026-01-12", "2026-01-19", "2027-01-04"]) {
      expect(checkReviewableWeek({ ...base, weekStart })).toEqual({
        ok: false,
        reason: "not_ended",
      });
    }
  });

  it("週の最終日が今日なら not_ended、翌日になれば ok(境界)", () => {
    expect(checkReviewableWeek({ ...base, today: "2026-01-11", weekStart: WEEK_START })).toEqual({
      ok: false,
      reason: "not_ended",
    });
    expect(checkReviewableWeek({ ...base, today: "2026-01-12", weekStart: WEEK_START })).toEqual({
      ok: true,
    });
  });

  it("52 週前の開始日は ok、53 週前は too_old(境界)", () => {
    expect(checkReviewableWeek({ ...base, weekStart: "2025-01-13" })).toEqual({ ok: true });
    expect(checkReviewableWeek({ ...base, weekStart: "2025-01-06" })).toEqual({
      ok: false,
      reason: "too_old",
    });
    expect(REVIEW_MAX_WEEKS_BACK).toBe(52);
  });

  it("weekStartsOn が範囲外なら例外(黙って通さない)", () => {
    expect(() =>
      checkReviewableWeek({ ...base, weekStartsOn: 7, weekStart: WEEK_START }),
    ).toThrow();
  });
});

describe("buildWeeklyReviewSummary", () => {
  it("success 4 / skipped 1 / 記録なし 2 → 4/6、pending は 0", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits: [
        habit("a", [
          onDay(0, "success"),
          onDay(1, "success"),
          onDay(2, "success"),
          onDay(3, "success"),
          onDay(4, "skipped"),
        ]),
      ],
      checkIns: [],
    });
    expect(summary.schemaVersion).toBe(1);
    expect(summary.weekStart).toBe("2026-01-05");
    expect(summary.weekEnd).toBe("2026-01-11");
    expect(summary.overall).toEqual({
      scheduled: 7,
      success: 4,
      missed: 2,
      skipped: 1,
      pending: 0,
      successRate: 4 / 6,
    });
    expect(summary.habits).toHaveLength(1);
    expect(summary.habits[0]).toEqual({
      habitId: "a",
      kind: "build",
      name: "習慣a",
      scheduled: 7,
      success: 4,
      missed: 2,
      skipped: 1,
      pending: 0,
      successRate: 4 / 6,
    });
  });

  it("全体の成功率は合計件数から求める(習慣ごとの率の平均ではない)", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      // A: success 1 / missed 0(予定は月曜のみ)、B: success 1 / missed 2(予定は月・火・水)
      habits: [
        habit("a", [onDay(0, "success")], schedule([1])),
        habit("b", [onDay(0, "success")], schedule([1, 2, 3])),
      ],
      checkIns: [],
    });
    expect(summary.overall.success).toBe(2);
    expect(summary.overall.missed).toBe(2);
    expect(summary.overall.successRate).toBe(0.5);
  });

  it("週内に予定機会がない習慣は含めない(週の途中以降に開始した習慣・週外の予定のみ)", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits: [
        habit("a", []),
        habit("later", [], schedule(EVERY_DAY, "2026-01-12")),
        habit(
          "ended",
          [],
          [
            createScheduleVersion("build", {
              effectiveFrom: "2020-01-01",
              effectiveTo: "2026-01-04",
              daysOfWeek: EVERY_DAY,
              targetCount: 1,
            }),
          ],
        ),
      ],
      checkIns: [],
    });
    expect(summary.habits.map((item) => item.habitId)).toEqual(["a"]);
  });

  it("週の途中から開始した習慣は開始日以降の予定機会だけを数える(版切替)", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits: [habit("a", [], schedule(EVERY_DAY, "2026-01-09"))],
      checkIns: [],
    });
    expect(summary.habits[0]?.scheduled).toBe(3);
  });

  it("予定のない日・週外の記録は無視する", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits: [
        habit(
          "a",
          [
            onDay(0, "success"),
            onDay(1, "success"), // 火曜は予定外
            { date: "2026-01-04", status: "success" }, // 前週
            { date: "2026-01-12", status: "success" }, // 翌週
          ],
          schedule([1]),
        ),
      ],
      checkIns: [],
    });
    expect(summary.overall).toMatchObject({ scheduled: 1, success: 1, missed: 0 });
  });

  it("習慣も記録もない週は件数 0・成功率 null・チェックインなし", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits: [],
      checkIns: [],
    });
    expect(summary.overall).toEqual({
      scheduled: 0,
      success: 0,
      missed: 0,
      skipped: 0,
      pending: 0,
      successRate: null,
    });
    expect(summary.habits).toEqual([]);
    expect(summary.checkIn).toEqual({ days: 0, averageMood: null, averageDifficulty: null });
  });

  it("全予定が skipped なら成功率は null", () => {
    const entries = [0, 1, 2, 3, 4, 5, 6].map((offset) => onDay(offset, "skipped"));
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits: [habit("a", entries)],
      checkIns: [],
    });
    expect(summary.overall.successRate).toBeNull();
    expect(summary.overall.skipped).toBe(7);
  });

  it("チェックインの平均は値のある日だけで求める", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits: [],
      checkIns: [
        { mood: 4, difficulty: 3 },
        { mood: 2, difficulty: null },
        { mood: null, difficulty: null },
      ],
    });
    expect(summary.checkIn).toEqual({ days: 3, averageMood: 3, averageDifficulty: 3 });
  });

  it("まだ終わっていない週では今日の未記録は pending(分類は T-204 と共通)", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: "2026-01-12",
      today: TODAY,
      habits: [habit("a", [])],
      checkIns: [],
    });
    expect(summary.overall).toMatchObject({ scheduled: 7, missed: 2, pending: 5 });
  });

  it("結果を凍結し、入力を変更しない", () => {
    const entries = [onDay(0, "success")];
    const habits = [habit("a", entries)];
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits,
      checkIns: [],
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(entries).toEqual([onDay(0, "success")]);
  });

  it("習慣名・自由記述以外(purpose/cue 等)は結果に含まれない", () => {
    const summary = buildWeeklyReviewSummary({
      weekStart: WEEK_START,
      today: TODAY,
      habits: [habit("a", [])],
      checkIns: [],
    });
    expect(Object.keys(summary.habits[0] ?? {}).sort()).toEqual(
      [
        "habitId",
        "kind",
        "missed",
        "name",
        "pending",
        "scheduled",
        "skipped",
        "success",
        "successRate",
      ].sort(),
    );
  });
});

describe("buildWeeklyReviewSummary: 性質テスト(シード固定)", () => {
  function rng(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }
  const statuses: HabitEntryStatus[] = ["success", "missed", "skipped"];

  it("件数の恒等式・全体=習慣の合計・成功率の定義・冪等性が常に成り立つ", () => {
    const random = rng(20261006);
    for (let run = 0; run < 300; run += 1) {
      const habits: WeeklyReviewHabitInput[] = [];
      const habitCount = Math.floor(random() * 5);
      for (let h = 0; h < habitCount; h += 1) {
        const picked = EVERY_DAY.filter(() => random() < 0.5);
        const days = picked.length > 0 ? picked : [1];
        const entries: StatisticsEntry[] = [];
        for (let d = -3; d < 10; d += 1) {
          if (random() < 0.6) {
            entries.push(onDay(d, statuses[Math.floor(random() * statuses.length)] ?? "success"));
          }
        }
        habits.push(
          habit(
            String(h),
            entries,
            schedule(days, addCalendarDays(WEEK_START, Math.floor(random() * 10) - 5)),
          ),
        );
      }
      const checkIns = Array.from({ length: Math.floor(random() * 8) }, () => ({
        mood: random() < 0.3 ? null : 1 + Math.floor(random() * 5),
        difficulty: random() < 0.3 ? null : 1 + Math.floor(random() * 5),
      }));
      const input = { weekStart: WEEK_START, today: TODAY, habits, checkIns };
      const summary = buildWeeklyReviewSummary(input);

      let total = 0;
      for (const item of [summary.overall, ...summary.habits]) {
        expect(item.scheduled).toBe(item.success + item.missed + item.skipped + item.pending);
        const denominator = item.success + item.missed;
        expect(item.successRate).toBe(denominator === 0 ? null : item.success / denominator);
        expect(item.pending).toBe(0);
      }
      for (const item of summary.habits) {
        expect(item.scheduled).toBeGreaterThan(0);
        total += item.scheduled;
      }
      expect(summary.overall.scheduled).toBe(total);
      expect(summary.overall.success).toBe(summary.habits.reduce((s, i) => s + i.success, 0));
      expect(summary.overall.missed).toBe(summary.habits.reduce((s, i) => s + i.missed, 0));
      expect(summary.overall.skipped).toBe(summary.habits.reduce((s, i) => s + i.skipped, 0));
      expect(summary.checkIn.days).toBe(checkIns.length);
      for (const average of [summary.checkIn.averageMood, summary.checkIn.averageDifficulty]) {
        if (average !== null) {
          expect(average).toBeGreaterThanOrEqual(1);
          expect(average).toBeLessThanOrEqual(5);
        }
      }
      expect(buildWeeklyReviewSummary(input)).toEqual(summary);
    }
  });
});

describe("normalizeWeeklyReflection", () => {
  it("前後の空白を除去する(内部の改行・空白は保持)", () => {
    expect(normalizeWeeklyReflection("  よく続いた\n  来週も  ")).toBe("よく続いた\n  来週も");
  });

  it("null・undefined・空・空白のみ(全角空白・改行・タブを含む)は null(クリア)", () => {
    for (const value of [null, undefined, "", "   ", "\n\t ", "　"]) {
      expect(normalizeWeeklyReflection(value)).toBeNull();
    }
  });

  it("空白除去後に 1000 文字ちょうどは可、1001 文字は InvalidWeeklyReviewError(reflection)", () => {
    const max = "Z".repeat(WEEKLY_REVIEW_REFLECTION_MAX_LENGTH);
    expect(normalizeWeeklyReflection(` ${max} `)).toBe(max);
    expect(() => normalizeWeeklyReflection(`${max}Z`)).toThrow(InvalidWeeklyReviewError);
    try {
      normalizeWeeklyReflection(`${max}Z`);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWeeklyReviewError);
      expect((error as InvalidWeeklyReviewError).field).toBe("reflection");
      // 入力の自由記述をエラーメッセージに含めない
      expect((error as Error).message).not.toContain("Z");
    }
  });

  it("性質: 冪等(normalize を 2 回かけても同じ)・結果は trim 済みで空でない", () => {
    let state = 7;
    const next = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const alphabet = [" ", "\n", "\t", "　", "a", "あ", "1"];
    for (let run = 0; run < 500; run += 1) {
      const length = Math.floor(next() * 30);
      const value = Array.from(
        { length },
        () => alphabet[Math.floor(next() * alphabet.length)],
      ).join("");
      const once = normalizeWeeklyReflection(value);
      if (once === null) continue;
      expect(once).toBe(once.trim());
      expect(once.length).toBeGreaterThan(0);
      expect(normalizeWeeklyReflection(once)).toBe(once);
    }
  });
});
