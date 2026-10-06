import { z } from "zod";

import { HABIT_NAME_MAX_LENGTH, HABIT_TEXT_MAX_LENGTH } from "./habits";

/**
 * AI coaching の versioned な入出力契約(docs/specs/ai-contracts.md AIC-001)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。すべて `.strict()` で未知キーを拒否する。
 * 非互換な変更は新 version の schema を追加し、既存 version は書き換えない。
 */
export const AI_SCHEMA_VERSION = "1";

export const AI_PURPOSES = ["habit_design", "weekly_improvement"] as const;
export const aiPurposeSchema = z.enum(AI_PURPOSES);
export type AiPurpose = z.infer<typeof aiPurposeSchema>;

export const CONTENT_SAFETY_STATUSES = ["pass", "fallback", "required_human_review"] as const;
export const contentSafetyStatusSchema = z.enum(CONTENT_SAFETY_STATUSES);
export type ContentSafetyStatus = z.infer<typeof contentSafetyStatusSchema>;

/** validator が返す reason code。追加時は Application の exhaustive check が取りこぼしを検知する。 */
export const CONTENT_SAFETY_REASON_CODES = [
  "third_party_name",
  "promotional_use_of_third_party_name",
  "endorsement_claim",
  "long_quotation",
  "excessive_source_overlap",
  "reproduction_instruction",
] as const;
export const contentSafetyReasonCodeSchema = z.enum(CONTENT_SAFETY_REASON_CODES);
export type ContentSafetyReasonCode = z.infer<typeof contentSafetyReasonCodeSchema>;

export const contentSafetySchema = z
  .object({
    status: contentSafetyStatusSchema,
    reasonCodes: z.array(contentSafetyReasonCodeSchema).max(CONTENT_SAFETY_REASON_CODES.length),
    validatorVersion: z.string().min(1).max(64),
    fallbackVersion: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type ContentSafety = z.infer<typeof contentSafetySchema>;

export const AI_FREE_TEXT_MAX_LENGTH = 1000;
const AI_SHORT_TEXT_MAX_LENGTH = 300;

/** 改行(\n)とタブ(\t)以外の制御文字(NUL を含む)を含むか。 */
function hasDisallowedControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x09) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function text(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasDisallowedControlCharacter(value), {
      message: "制御文字は使用できません",
    });
}

const habitKindSchema = z.enum(["build", "reduce"]);
const calendarDateSchema = z.iso.date();
const countSchema = z.number().int().min(0).max(1000);

/** 習慣設計(T-304)の入力。email・表示名・内部 ID を持たない。 */
export const habitDesignInputV1Schema = z
  .object({
    subjectId: z.uuid(),
    habitKind: habitKindSchema,
    goal: text(AI_FREE_TEXT_MAX_LENGTH),
    constraints: text(AI_FREE_TEXT_MAX_LENGTH).nullable(),
  })
  .strict();
export type HabitDesignInputV1 = z.infer<typeof habitDesignInputV1Schema>;

export const WEEKLY_INPUT_MAX_HABITS = 10;

/** 週次改善(T-305)の入力。集計は決定論的に計算済みの値だけを渡す。 */
export const weeklyImprovementInputV1Schema = z
  .object({
    subjectId: z.uuid(),
    weekStart: calendarDateSchema,
    habits: z
      .array(
        z
          .object({
            kind: habitKindSchema,
            name: text(HABIT_NAME_MAX_LENGTH),
            cue: text(HABIT_TEXT_MAX_LENGTH).nullable(),
            minimumAction: text(HABIT_TEXT_MAX_LENGTH).nullable(),
            scheduledCount: countSchema,
            successCount: countSchema,
            skippedCount: countSchema,
            missedCount: countSchema,
          })
          .strict(),
      )
      .max(WEEKLY_INPUT_MAX_HABITS),
    checkIn: z
      .object({
        days: z.number().int().min(0).max(7),
        averageMood: z.number().min(1).max(5).nullable(),
        averageDifficulty: z.number().min(1).max(5).nullable(),
      })
      .strict(),
    reflection: text(AI_FREE_TEXT_MAX_LENGTH).nullable(),
  })
  .strict();
export type WeeklyImprovementInputV1 = z.infer<typeof weeklyImprovementInputV1Schema>;

const safetyNoticeSchema = z
  .object({
    requiresHumanSupport: z.boolean(),
    message: text(AI_SHORT_TEXT_MAX_LENGTH).nullable(),
  })
  .strict();

/** 習慣設計の提案。AI は設定を変更せず、提案を返すだけ(採用はユーザー操作)。 */
export const habitDesignProposalV1Schema = z
  .object({
    schemaVersion: z.literal(AI_SCHEMA_VERSION),
    summary: text(AI_SHORT_TEXT_MAX_LENGTH),
    habit: z
      .object({
        kind: habitKindSchema,
        name: text(HABIT_NAME_MAX_LENGTH),
        purpose: text(HABIT_TEXT_MAX_LENGTH),
        cue: text(HABIT_TEXT_MAX_LENGTH),
        minimumAction: text(HABIT_TEXT_MAX_LENGTH),
      })
      .strict(),
    rationale: text(AI_SHORT_TEXT_MAX_LENGTH),
    safety: safetyNoticeSchema,
  })
  .strict();
export type HabitDesignProposalV1 = z.infer<typeof habitDesignProposalV1Schema>;

export const WEEKLY_PLAN_MAX_OBSERVATIONS = 5;
export const WEEKLY_PLAN_MAX_SUGGESTIONS = 3;

export const WEEKLY_CHANGE_TYPES = [
  "cue",
  "minimum_action",
  "schedule",
  "environment",
  "no_change",
] as const;

/** docs/05-api-and-ai-design.md の `WeeklyImprovementPlanV1`。観測は入力データの根拠(evidence)を必須とする。 */
export const weeklyImprovementPlanV1Schema = z
  .object({
    schemaVersion: z.literal(AI_SCHEMA_VERSION),
    summary: text(AI_SHORT_TEXT_MAX_LENGTH),
    observations: z
      .array(
        z
          .object({
            evidence: text(AI_SHORT_TEXT_MAX_LENGTH),
            interpretation: text(AI_SHORT_TEXT_MAX_LENGTH),
          })
          .strict(),
      )
      .max(WEEKLY_PLAN_MAX_OBSERVATIONS),
    suggestions: z
      .array(
        z
          .object({
            title: text(HABIT_NAME_MAX_LENGTH),
            rationale: text(AI_SHORT_TEXT_MAX_LENGTH),
            changeType: z.enum(WEEKLY_CHANGE_TYPES),
            proposedValue: text(HABIT_TEXT_MAX_LENGTH).nullable(),
            confidence: z.enum(["low", "medium", "high"]),
          })
          .strict(),
      )
      .max(WEEKLY_PLAN_MAX_SUGGESTIONS),
    safety: safetyNoticeSchema,
  })
  .strict();
export type WeeklyImprovementPlanV1 = z.infer<typeof weeklyImprovementPlanV1Schema>;
