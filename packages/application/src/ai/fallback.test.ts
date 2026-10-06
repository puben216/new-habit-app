import { habitDesignProposalV1Schema, weeklyImprovementPlanV1Schema } from "@habit-app/contracts";
import { describe, expect, it } from "vitest";

import { validateGeneratedContent } from "./content-validator";
import { buildHabitDesignFallback, buildWeeklyImprovementFallback } from "./fallback";
import { habitDesignInput, POLICY } from "./fixtures";
import { collectStrings } from "./text-inspection";

describe("versioned fallback", () => {
  it("習慣設計の fallback は出力 schema と validator を満たす(build / reduce)", () => {
    for (const habitKind of ["build", "reduce"] as const) {
      const output = buildHabitDesignFallback({ ...habitDesignInput, habitKind });
      expect(habitDesignProposalV1Schema.safeParse(output).success).toBe(true);
      expect(validateGeneratedContent(collectStrings(output), POLICY).status).toBe("pass");
      expect(output.habit.kind).toBe(habitKind);
    }
  });

  it("週次の fallback は出力 schema と validator を満たす", () => {
    const output = buildWeeklyImprovementFallback();
    expect(weeklyImprovementPlanV1Schema.safeParse(output).success).toBe(true);
    expect(validateGeneratedContent(collectStrings(output), POLICY).status).toBe("pass");
  });

  it("ユーザーの自由記述を再掲しない", () => {
    const input = { ...habitDesignInput, goal: "秘密の目標ABC", constraints: "秘密の制約XYZ" };
    const text = collectStrings(buildHabitDesignFallback(input)).join("\n");
    expect(text).not.toContain("ABC");
    expect(text).not.toContain("XYZ");
    const week = collectStrings(buildWeeklyImprovementFallback()).join("\n");
    expect(week).not.toContain("QQQ");
  });
});
