import type {
  HabitDesignInputV1,
  HabitDesignProposalV1,
  WeeklyImprovementInputV1,
  WeeklyImprovementPlanV1,
} from "@habit-app/contracts";

import type { ContentSafetyPolicy } from "./content-validator";

/** テスト用の架空データのみ。実在の書籍・著者・ブランド名は使わない。 */
export const FICTIONAL_BRAND = "架空ブランドアルファ";
export const FICTIONAL_BOOK = "架空の書『ゼロからの継続術』";
export const REFERENCE_EXCERPT =
  "毎朝の五分間を静かに過ごすことで一日の流れが穏やかに整っていくと筆者は述べている";

export const POLICY: ContentSafetyPolicy = {
  managedTerms: [FICTIONAL_BRAND, "架空の書ゼロからの継続術"],
  referenceExcerpts: [REFERENCE_EXCERPT],
};

export const SUBJECT_ID = "6f1c2f0e-8f55-4c53-9d0e-1d8f6f0a7a11";

export const habitDesignInput: HabitDesignInputV1 = {
  subjectId: SUBJECT_ID,
  habitKind: "build",
  goal: "朝に軽い運動を続けたい",
  constraints: "平日は時間が短い",
};

export const weeklyInput: WeeklyImprovementInputV1 = {
  subjectId: SUBJECT_ID,
  weekStart: "2026-09-28",
  habits: [
    {
      kind: "build",
      name: "朝の読書",
      cue: "朝食後",
      minimumAction: "1ページ読む",
      scheduledCount: 5,
      successCount: 3,
      skippedCount: 1,
      missedCount: 1,
    },
  ],
  checkIn: { days: 4, averageMood: 3.2, averageDifficulty: 3.5 },
  reflection: "忙しい日が続いた",
};

export function validProposal(
  overrides: Partial<HabitDesignProposalV1> = {},
): HabitDesignProposalV1 {
  return {
    schemaVersion: "1",
    summary: "小さく始められる案です。",
    habit: {
      kind: "build",
      name: "朝のストレッチ",
      purpose: "体を軽く動かして一日を始める",
      cue: "起きて水を飲んだ後",
      minimumAction: "肩を回す",
    },
    rationale: "最小の行動なら続けやすくなります。",
    safety: { requiresHumanSupport: false, message: null },
    ...overrides,
  };
}

export function validPlan(
  overrides: Partial<WeeklyImprovementPlanV1> = {},
): WeeklyImprovementPlanV1 {
  return {
    schemaVersion: "1",
    summary: "今週は半分以上の日に取り組めました。",
    observations: [{ evidence: "予定5回中3回成功", interpretation: "流れができ始めています" }],
    suggestions: [
      {
        title: "最小行動を小さくする",
        rationale: "忙しい日にも取り組みやすくするため",
        changeType: "minimum_action",
        proposedValue: "1分だけ読む",
        confidence: "medium",
      },
    ],
    safety: { requiresHumanSupport: false, message: null },
    ...overrides,
  };
}
