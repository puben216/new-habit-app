import { z } from "zod";

/**
 * `/api/v1/weekly-reviews` の契約(docs/specs/weekly-review.md API and Events 節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。request は `.strict()` で未知キーを拒否する。
 * 集計の定義は Domain(`buildWeeklyReviewSummary`)が持つ。ここでは形と値域のみを表す。
 */

/** 振り返りの最大文字数。Domain の `WEEKLY_REVIEW_REFLECTION_MAX_LENGTH` と同じ値(AI 入力の自由記述上限と同値)。 */
export const WEEKLY_REVIEW_REFLECTION_MAX_LENGTH = 1000;

export const WEEKLY_REVIEW_LIST_DEFAULT_LIMIT = 20;
export const WEEKLY_REVIEW_LIST_MAX_LIMIT = 50;
export const WEEKLY_REVIEW_CURSOR_MAX_LENGTH = 128;

/** 改行(\n)とタブ(\t)は許可し、それ以外の制御文字(NUL を含む)を拒否する。 */
function hasDisallowedControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x09) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const calendarDateSchema = z.iso.date();
const countSchema = z.number().int().min(0);
const scaleAverageSchema = z.number().min(1).max(5).nullable();

export const createWeeklyReviewRequestSchema = z.object({ weekStart: calendarDateSchema }).strict();
export type CreateWeeklyReviewRequest = z.infer<typeof createWeeklyReviewRequestSchema>;

const reflectionSchema = z
  .string()
  .max(WEEKLY_REVIEW_REFLECTION_MAX_LENGTH)
  .refine((value) => !hasDisallowedControlCharacter(value), {
    message: "制御文字は使用できません",
  });

/** 少なくとも 1 項目が必要。`status` に指定できるのは `completed`(確定)のみ。 */
export const updateWeeklyReviewRequestSchema = z
  .object({
    reflection: reflectionSchema.nullable().optional(),
    status: z.literal("completed").optional(),
  })
  .strict()
  .refine((value) => value.reflection !== undefined || value.status !== undefined, {
    message: "reflection、status のいずれか 1 つ以上を指定してください",
  });
export type UpdateWeeklyReviewRequest = z.infer<typeof updateWeeklyReviewRequestSchema>;

export const listWeeklyReviewsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WEEKLY_REVIEW_LIST_MAX_LIMIT)
      .default(WEEKLY_REVIEW_LIST_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(WEEKLY_REVIEW_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();
export type ListWeeklyReviewsQuery = z.infer<typeof listWeeklyReviewsQuerySchema>;

/** path の `{reviewId}`(外部公開 ID)。 */
export const weeklyReviewIdParamSchema = z.uuid();

const outcomesSchema = z
  .object({
    scheduled: countSchema,
    success: countSchema,
    missed: countSchema,
    skipped: countSchema,
    pending: countSchema,
    /** `success / (success + missed)`(0〜1)。分母 0 は null。 */
    successRate: z.number().min(0).max(1).nullable(),
  })
  .strict();

/** 保存済みスナップショット(`summary_json`)の `schemaVersion: 1`。保存時の形をそのまま返す。 */
export const weeklyReviewSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    weekStart: calendarDateSchema,
    weekEnd: calendarDateSchema,
    overall: outcomesSchema,
    habits: z.array(
      outcomesSchema.extend({
        habitId: z.uuid(),
        kind: z.enum(["build", "reduce"]),
        name: z.string(),
      }),
    ),
    checkIn: z
      .object({
        days: z.number().int().min(0).max(7),
        averageMood: scaleAverageSchema,
        averageDifficulty: scaleAverageSchema,
      })
      .strict(),
  })
  .strict();
export type WeeklyReviewSummaryResponse = z.infer<typeof weeklyReviewSummarySchema>;

export const weeklyReviewResponseSchema = z.object({
  id: z.uuid(),
  weekStart: calendarDateSchema,
  weekEnd: calendarDateSchema,
  timezone: z.string(),
  status: z.enum(["draft", "completed"]),
  summary: weeklyReviewSummarySchema,
  reflection: z.string().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WeeklyReviewResponse = z.infer<typeof weeklyReviewResponseSchema>;

export const weeklyReviewListResponseSchema = z.object({
  items: z.array(weeklyReviewResponseSchema),
  nextCursor: z.string().nullable(),
});
export type WeeklyReviewListResponse = z.infer<typeof weeklyReviewListResponseSchema>;
