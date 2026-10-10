import { WEEKLY_INPUT_MAX_HABITS } from "@habit-app/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  NIL_SUBJECT_ID,
  buildWeeklyImprovementInput,
  fingerprintWeeklyInput,
} from "./weekly-input";
import type { ActiveHabitDetail } from "./weekly-input";

const SUBJECT = "20000000-0000-4000-8000-000000000001";
const habitId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const outcomes = {
  scheduled: 7,
  success: 4,
  missed: 2,
  skipped: 1,
  pending: 0,
  successRate: 4 / 6,
};

function summaryOf(
  habitCount = 1,
  checkIn = { days: 2, averageMood: 3 as number | null, averageDifficulty: null as number | null },
) {
  return {
    schemaVersion: 1 as const,
    weekStart: "2026-01-05",
    weekEnd: "2026-01-11",
    overall: outcomes,
    habits: Array.from({ length: habitCount }, (_, i) => ({
      ...outcomes,
      habitId: habitId(i + 1),
      kind: "build" as const,
      name: `習慣${i + 1}`,
    })),
    checkIn,
  };
}

function details(count: number): Map<string, ActiveHabitDetail> {
  return new Map(
    Array.from({ length: count }, (_, i) => [
      habitId(i + 1),
      { cue: `きっかけ${i + 1}`, minimumAction: `最小${i + 1}` },
    ]),
  );
}

describe("buildWeeklyImprovementInput", () => {
  it("summary と active 習慣の cue/minimumAction から入力を組み立てる", () => {
    const result = buildWeeklyImprovementInput(
      { summary: summaryOf(1), reflection: "よく続いた" },
      details(1),
      SUBJECT,
    );
    expect(result).toEqual({
      ok: true,
      input: {
        subjectId: SUBJECT,
        weekStart: "2026-01-05",
        habits: [
          {
            kind: "build",
            name: "習慣1",
            cue: "きっかけ1",
            minimumAction: "最小1",
            scheduledCount: 7,
            successCount: 4,
            skippedCount: 1,
            missedCount: 2,
          },
        ],
        checkIn: { days: 2, averageMood: 3, averageDifficulty: null },
        reflection: "よく続いた",
      },
    });
  });

  it("入力に habit/review の外部 ID・pending・successRate を持ち込まない", () => {
    const result = buildWeeklyImprovementInput(
      { summary: summaryOf(2), reflection: null },
      details(2),
      SUBJECT,
    );
    if (!result.ok) throw new Error("expected ok");
    const text = JSON.stringify(result.input);
    expect(text).not.toContain(habitId(1));
    expect(text).not.toContain("habitId");
    expect(text).not.toContain("successRate");
    expect(text).not.toContain("pending");
    expect(Object.keys(result.input).sort()).toEqual(
      ["checkIn", "habits", "reflection", "subjectId", "weekStart"].sort(),
    );
  });

  it("アーカイブ済み(active にない)習慣は cue/minimumAction が null", () => {
    const result = buildWeeklyImprovementInput(
      { summary: summaryOf(2), reflection: null },
      details(1),
      SUBJECT,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.habits[1]).toMatchObject({ cue: null, minimumAction: null });
  });

  it(`習慣は summary の順に最大 ${WEEKLY_INPUT_MAX_HABITS} 件`, () => {
    const result = buildWeeklyImprovementInput(
      { summary: summaryOf(WEEKLY_INPUT_MAX_HABITS + 3), reflection: null },
      details(WEEKLY_INPUT_MAX_HABITS + 3),
      SUBJECT,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.habits.map((habit) => habit.name)).toEqual(
      Array.from({ length: WEEKLY_INPUT_MAX_HABITS }, (_, i) => `習慣${i + 1}`),
    );
  });

  it("schema に適合しない入力(制御文字を含む reflection)は ok=false", () => {
    const result = buildWeeklyImprovementInput(
      { summary: summaryOf(1), reflection: "a\u0000b" },
      details(1),
      SUBJECT,
    );
    expect(result).toEqual({ ok: false });
  });

  it("習慣なし・reflection なしでも組み立てられる", () => {
    const result = buildWeeklyImprovementInput(
      {
        summary: summaryOf(0, { days: 0, averageMood: null, averageDifficulty: null }),
        reflection: null,
      },
      new Map(),
      SUBJECT,
    );
    expect(result.ok).toBe(true);
  });
});

describe("fingerprintWeeklyInput", () => {
  const build = (reflection: string | null, subjectId: string, habitCount = 1) => {
    const result = buildWeeklyImprovementInput(
      { summary: summaryOf(habitCount), reflection },
      details(habitCount),
      subjectId,
    );
    if (!result.ok) throw new Error("expected ok");
    return result.input;
  };

  it("SHA-256 の hex(64 文字)", () => {
    expect(fingerprintWeeklyInput(build("a", SUBJECT))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("subjectId に依存しない(job ごとに変わる値で fingerprint が変わらない)", () => {
    expect(fingerprintWeeklyInput(build("a", SUBJECT))).toBe(
      fingerprintWeeklyInput(build("a", NIL_SUBJECT_ID)),
    );
  });

  it("入力が変わると変わる(reflection、習慣、チェックイン)", () => {
    const base = fingerprintWeeklyInput(build("a", SUBJECT));
    expect(fingerprintWeeklyInput(build("b", SUBJECT))).not.toBe(base);
    expect(fingerprintWeeklyInput(build("a", SUBJECT, 2))).not.toBe(base);
    expect(fingerprintWeeklyInput(build(null, SUBJECT))).not.toBe(base);
  });

  it("性質: 任意の reflection で決定的で、異なる reflection は異なる値", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 40 })
          .filter((s) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)),
        fc
          .string({ minLength: 1, maxLength: 40 })
          .filter((s) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)),
        (a, b) => {
          expect(fingerprintWeeklyInput(build(a, SUBJECT))).toBe(
            fingerprintWeeklyInput(build(a, SUBJECT)),
          );
          if (a !== b) {
            expect(fingerprintWeeklyInput(build(a, SUBJECT))).not.toBe(
              fingerprintWeeklyInput(build(b, SUBJECT)),
            );
          }
        },
      ),
    );
  });
});
