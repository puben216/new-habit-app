import { z } from "zod";

import { contentSafetySchema, weeklyImprovementPlanV1Schema } from "./ai";

/**
 * AI job の契約(docs/specs/ai-queue-pipeline.md API and Events 節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。
 */

export const AI_JOB_KINDS = ["weekly_improvement", "habit_design"] as const;
export const AI_JOB_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "fallback",
] as const;

/** T-302 の `FallbackReason` に、worker が受信上限まで失敗した場合の `worker_exhausted` を加えたもの。 */
export const AI_JOB_FALLBACK_REASONS = [
  "disabled",
  "input_rejected",
  "provider_unavailable",
  "provider_refusal",
  "invalid_output",
  "safety_rejected",
  "validator_error",
  "worker_exhausted",
] as const;
export const AI_JOB_FAILURE_CODES = ["subject_unavailable", "invalid_input"] as const;

/** `ai-coaching` queue の message。入力・自由記述・user ID を含めない(AJOB-INV-006)。 */
export const aiJobMessageV1Schema = z.object({ v: z.literal(1), jobId: z.uuid() }).strict();
export type AiJobMessageV1 = z.infer<typeof aiJobMessageV1Schema>;

/** `ai_jobs.result_json` の `schemaVersion: 1`。生の model 応答・prompt・入力は含めない(AJOB-006)。 */
export const aiJobResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.enum(["ai", "fallback"]),
    output: weeklyImprovementPlanV1Schema,
    contentSafety: contentSafetySchema,
    fallbackReason: z.enum(AI_JOB_FALLBACK_REASONS).nullable(),
  })
  .strict()
  .refine((value) => (value.source === "fallback") === (value.fallbackReason !== null), {
    message: "fallbackReason は source が fallback のときだけ指定します",
  });
export type AiJobResultV1 = z.infer<typeof aiJobResultV1Schema>;

/** path の `{jobId}`(外部公開 ID)。 */
export const aiJobIdParamSchema = z.uuid();

/** `POST /weekly-reviews/{reviewId}/analysis` の body。なし、または `{}` のみ。 */
export const requestWeeklyAnalysisBodySchema = z.object({}).strict();

export const aiJobResponseSchema = z.object({
  id: z.uuid(),
  kind: z.enum(AI_JOB_KINDS),
  status: z.enum(AI_JOB_STATUS_VALUES),
  subject: z.object({ type: z.string().min(1), id: z.uuid() }),
  promptVersion: z.string().min(1),
  outputSchemaVersion: z.string().min(1),
  result: aiJobResultV1Schema.nullable(),
  failureCode: z.enum(AI_JOB_FAILURE_CODES).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AiJobResponse = z.infer<typeof aiJobResponseSchema>;
