import {
  AI_SCHEMA_VERSION,
  type HabitDesignInputV1,
  type HabitDesignProposalV1,
  type WeeklyImprovementPlanV1,
} from "@habit-app/contracts";

/**
 * 第三者固有表現を含まない versioned 定型 fallback(docs/specs/ai-contracts.md AIC-005、IPG-004)。
 * ユーザーの自由記述を引用・転記しない(入力に第三者コンテンツが含まれても再掲しない)。
 * 文面を変えるときは version を上げる。
 */
export const SAFE_FALLBACK_VERSION = "safe-fallback/1";

const NO_SUPPORT_NEEDED = { requiresHumanSupport: false, message: null } as const;

export function buildHabitDesignFallback(input: HabitDesignInputV1): HabitDesignProposalV1 {
  const isBuild = input.habitKind === "build";
  return {
    schemaVersion: AI_SCHEMA_VERSION,
    summary: "無理なく続けられる、小さな最初の一歩を提案します。",
    habit: {
      kind: input.habitKind,
      name: isBuild ? "毎日の小さな習慣" : "控えたい習慣を少し減らす",
      purpose: isBuild ? "続けやすい形で習慣を始める" : "負担の少ない範囲で回数を減らす",
      cue: isBuild ? "毎日決まっている行動の直後" : "つい手が伸びる場面の直前",
      minimumAction: isBuild ? "1分だけ取り組む" : "いつもより1回だけ控える",
    },
    rationale: "最小の行動から始めると、続けやすくなります。内容はあとで自由に編集できます。",
    safety: NO_SUPPORT_NEEDED,
  };
}

export function buildWeeklyImprovementFallback(): WeeklyImprovementPlanV1 {
  return {
    schemaVersion: AI_SCHEMA_VERSION,
    summary: "今週の記録をふまえ、無理なく続けるための小さな見直しを提案します。",
    observations: [],
    suggestions: [
      {
        title: "最小行動を小さくする",
        rationale: "続けにくい日があっても、いまの半分の大きさなら取り組みやすくなります。",
        changeType: "minimum_action",
        proposedValue: null,
        confidence: "low",
      },
    ],
    safety: NO_SUPPORT_NEEDED,
  };
}
