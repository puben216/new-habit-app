import { AiCoachProviderError, type AiCoachGenerateParams } from "@habit-app/application";
import { habitDesignProposalV1Schema, weeklyImprovementPlanV1Schema } from "@habit-app/contracts";
import { describe, expect, it } from "vitest";

import { createFakeAiCoach } from "./fake-ai-coach";
import { createInMemoryRightsRegistry } from "./in-memory-rights-registry";

const SUBJECT = "6f1c2f0e-8f55-4c53-9d0e-1d8f6f0a7a11";

function params(
  purpose: "habit_design" | "weekly_improvement",
  signal = new AbortController().signal,
): AiCoachGenerateParams {
  const base = { promptVersion: "p/1", systemPolicy: "policy", signal };
  return purpose === "habit_design"
    ? {
        ...base,
        purpose,
        input: { subjectId: SUBJECT, habitKind: "build", goal: "運動したい", constraints: null },
      }
    : {
        ...base,
        purpose,
        input: {
          subjectId: SUBJECT,
          weekStart: "2026-09-28",
          habits: [],
          checkIn: { days: 0, averageMood: null, averageDifficulty: null },
          reflection: null,
        },
      };
}

describe("createFakeAiCoach", () => {
  it("台本が空なら purpose に応じた schema 有効な出力を返す", async () => {
    const coach = createFakeAiCoach();
    const design = await coach.generate(params("habit_design"));
    const weekly = await coach.generate(params("weekly_improvement"));
    expect(
      design.outcome === "completed" &&
        habitDesignProposalV1Schema.safeParse(design.rawOutput).success,
    ).toBe(true);
    expect(
      weekly.outcome === "completed" &&
        weeklyImprovementPlanV1Schema.safeParse(weekly.rawOutput).success,
    ).toBe(true);
    expect(coach.calls).toHaveLength(2);
  });

  it("台本の completed / refusal / error を順に再生する", async () => {
    const coach = createFakeAiCoach([
      { kind: "completed", rawOutput: { custom: true }, model: "m" },
      { kind: "refusal" },
      { kind: "error", errorKind: "rate_limited" },
    ]);
    await expect(coach.generate(params("habit_design"))).resolves.toEqual({
      outcome: "completed",
      rawOutput: { custom: true },
      model: "m",
    });
    await expect(coach.generate(params("habit_design"))).resolves.toEqual({ outcome: "refusal" });
    await expect(coach.generate(params("habit_design"))).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("hang は abort で timeout として終了する", async () => {
    const controller = new AbortController();
    const coach = createFakeAiCoach([{ kind: "hang" }]);
    const pending = coach.generate(params("habit_design", controller.signal));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AiCoachProviderError);
  });
});

describe("createInMemoryRightsRegistry", () => {
  it("登録済みを返し、未登録は null", async () => {
    const record = {
      sourceId: "src-1",
      origin: "o",
      rightsBasis: "b",
      allowedUses: ["rag"] as const,
      reviewedAt: new Date("2026-09-01T00:00:00Z"),
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    };
    const registry = createInMemoryRightsRegistry([record]);
    await expect(registry.find("src-1")).resolves.toEqual(record);
    await expect(registry.find("missing")).resolves.toBeNull();
  });
});
