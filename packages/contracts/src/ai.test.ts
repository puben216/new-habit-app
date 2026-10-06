import { describe, expect, it } from "vitest";

import {
  AI_FREE_TEXT_MAX_LENGTH,
  WEEKLY_PLAN_MAX_SUGGESTIONS,
  contentSafetySchema,
  habitDesignInputV1Schema,
  habitDesignProposalV1Schema,
  weeklyImprovementInputV1Schema,
  weeklyImprovementPlanV1Schema,
} from "./index";

const SUBJECT = "6f1c2f0e-8f55-4c53-9d0e-1d8f6f0a7a11";

const validPlan = {
  schemaVersion: "1",
  summary: "今週は朝の記録が安定していました。",
  observations: [{ evidence: "予定5回中4回成功", interpretation: "朝の流れが定着しつつあります" }],
  suggestions: [
    {
      title: "最小行動を小さくする",
      rationale: "難易度が高めの日があったため",
      changeType: "minimum_action",
      proposedValue: "1ページだけ読む",
      confidence: "medium",
    },
  ],
  safety: { requiresHumanSupport: false, message: null },
};

describe("weeklyImprovementPlanV1Schema", () => {
  it("有効な出力を受理する", () => {
    expect(weeklyImprovementPlanV1Schema.safeParse(validPlan).success).toBe(true);
  });

  it("未知キーを拒否する", () => {
    expect(weeklyImprovementPlanV1Schema.safeParse({ ...validPlan, extra: 1 }).success).toBe(false);
  });

  it("schemaVersion が違うものを拒否する", () => {
    expect(
      weeklyImprovementPlanV1Schema.safeParse({ ...validPlan, schemaVersion: "2" }).success,
    ).toBe(false);
  });

  it("文字列・配列の上限超過(oversize)を拒否する", () => {
    expect(
      weeklyImprovementPlanV1Schema.safeParse({ ...validPlan, summary: "あ".repeat(301) }).success,
    ).toBe(false);
    const suggestion = validPlan.suggestions[0];
    const many = Array.from({ length: WEEKLY_PLAN_MAX_SUGGESTIONS + 1 }, () => suggestion);
    expect(
      weeklyImprovementPlanV1Schema.safeParse({ ...validPlan, suggestions: many }).success,
    ).toBe(false);
  });

  it("未知の changeType と制御文字を拒否する", () => {
    const bad = {
      ...validPlan,
      suggestions: [{ ...validPlan.suggestions[0], changeType: "delete_habit" }],
    };
    expect(weeklyImprovementPlanV1Schema.safeParse(bad).success).toBe(false);
    expect(
      weeklyImprovementPlanV1Schema.safeParse({ ...validPlan, summary: "a\u0000b" }).success,
    ).toBe(false);
  });
});

describe("habitDesignProposalV1Schema", () => {
  it("有効な提案を受理し、未知キーを拒否する", () => {
    const proposal = {
      schemaVersion: "1",
      summary: "小さく始める案です。",
      habit: {
        kind: "build",
        name: "朝に本を読む",
        purpose: "学習の日常化",
        cue: "朝食後",
        minimumAction: "1ページ読む",
      },
      rationale: "続けやすい最小行動にしました。",
      safety: { requiresHumanSupport: false, message: null },
    };
    expect(habitDesignProposalV1Schema.safeParse(proposal).success).toBe(true);
    expect(habitDesignProposalV1Schema.safeParse({ ...proposal, habitId: "1" }).success).toBe(
      false,
    );
  });
});

describe("入力 schema", () => {
  it("習慣設計の入力は email や内部 ID を受け付けない", () => {
    const base = { subjectId: SUBJECT, habitKind: "build", goal: "運動したい", constraints: null };
    expect(habitDesignInputV1Schema.safeParse(base).success).toBe(true);
    expect(habitDesignInputV1Schema.safeParse({ ...base, email: "a@example.com" }).success).toBe(
      false,
    );
    expect(habitDesignInputV1Schema.safeParse({ ...base, userId: "1" }).success).toBe(false);
    expect(habitDesignInputV1Schema.safeParse({ ...base, subjectId: "1" }).success).toBe(false);
  });

  it("自由記述の長さ上限と制御文字を検査する", () => {
    const base = { subjectId: SUBJECT, habitKind: "build", goal: "運動したい", constraints: null };
    expect(
      habitDesignInputV1Schema.safeParse({
        ...base,
        goal: "あ".repeat(AI_FREE_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(habitDesignInputV1Schema.safeParse({ ...base, goal: "a\u0007b" }).success).toBe(false);
  });

  it("週次入力は習慣数の上限と集計値の値域を検査する", () => {
    const habit = {
      kind: "build",
      name: "読書",
      cue: null,
      minimumAction: null,
      scheduledCount: 5,
      successCount: 4,
      skippedCount: 0,
      missedCount: 1,
    };
    const base = {
      subjectId: SUBJECT,
      weekStart: "2026-09-28",
      habits: [habit],
      checkIn: { days: 4, averageMood: 3.5, averageDifficulty: null },
      reflection: null,
    };
    expect(weeklyImprovementInputV1Schema.safeParse(base).success).toBe(true);
    expect(
      weeklyImprovementInputV1Schema.safeParse({
        ...base,
        habits: Array.from({ length: 11 }, () => habit),
      }).success,
    ).toBe(false);
    expect(
      weeklyImprovementInputV1Schema.safeParse({
        ...base,
        checkIn: { days: 8, averageMood: null, averageDifficulty: null },
      }).success,
    ).toBe(false);
  });
});

describe("contentSafetySchema", () => {
  it("status と reason code を enum で制限する", () => {
    const ok = {
      status: "fallback",
      reasonCodes: ["third_party_name"],
      validatorVersion: "v",
      fallbackVersion: "f",
    };
    expect(contentSafetySchema.safeParse(ok).success).toBe(true);
    expect(contentSafetySchema.safeParse({ ...ok, status: "unknown" }).success).toBe(false);
    expect(contentSafetySchema.safeParse({ ...ok, reasonCodes: ["free text"] }).success).toBe(
      false,
    );
  });
});
