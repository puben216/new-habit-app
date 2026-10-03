import { z } from "zod";

/**
 * `/api/v1/habits` の契約(docs/specs/habit-api.md API and Events 節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。request は `.strict()` で未知キーを拒否する。
 *
 * 文字数上限は docs/10-decisions-and-open-questions.md の P2 が未決のため暫定値
 * (docs/specs/habit-api.md HAPI-INV-005)。確定後はこの定数だけを変更する。
 */
export const HABIT_NAME_MAX_LENGTH = 100;
export const HABIT_TEXT_MAX_LENGTH = 500;
export const HABIT_CURSOR_MAX_LENGTH = 512;
export const HABIT_LIST_DEFAULT_LIMIT = 20;
export const HABIT_LIST_MAX_LIMIT = 100;
/** request body の上限(バイト。Presentation が検査する)。 */
export const HABIT_REQUEST_BODY_MAX_BYTES = 16 * 1024;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 単一行の自由記述(制御文字を含む改行・タブ・NUL を拒否)。空文字の判定は Domain が行う。 */
function singleLineText(maxLength: number): z.ZodType<string> {
  return z
    .string()
    .max(maxLength)
    .refine((value) => !hasControlCharacter(value), {
      message: "制御文字は使用できません",
    });
}

const habitKindSchema = z.enum(["build", "reduce"]);
const habitStatusSchema = z.enum(["active", "archived"]);
const calendarDateSchema = z.iso.date();
const daysOfWeekSchema = z.array(z.number().int().min(0).max(6)).max(7);
const habitVersionSchema = z.number().int().min(1).max(2_147_483_647);

/** 作成/更新で指定するスケジュール。effectiveTo は受け付けない。localTime は Out of Scope。 */
export const habitScheduleInputSchema = z
  .object({
    effectiveFrom: calendarDateSchema,
    daysOfWeek: daysOfWeekSchema,
    targetCount: z.number().int().min(1).max(100).default(1),
  })
  .strict();
export type HabitScheduleInput = z.infer<typeof habitScheduleInputSchema>;

export const createHabitRequestSchema = z
  .object({
    kind: habitKindSchema,
    name: singleLineText(HABIT_NAME_MAX_LENGTH),
    purpose: singleLineText(HABIT_TEXT_MAX_LENGTH),
    cue: singleLineText(HABIT_TEXT_MAX_LENGTH),
    minimumAction: singleLineText(HABIT_TEXT_MAX_LENGTH),
    replacementAction: singleLineText(HABIT_TEXT_MAX_LENGTH).nullable().optional(),
    schedule: habitScheduleInputSchema,
  })
  .strict();
export type CreateHabitRequest = z.infer<typeof createHabitRequestSchema>;

/** kind は含めない(作成後変更不可)。変更項目が 1 つもない場合は拒否する。 */
export const updateHabitRequestSchema = z
  .object({
    version: habitVersionSchema,
    name: singleLineText(HABIT_NAME_MAX_LENGTH).optional(),
    purpose: singleLineText(HABIT_TEXT_MAX_LENGTH).optional(),
    cue: singleLineText(HABIT_TEXT_MAX_LENGTH).optional(),
    minimumAction: singleLineText(HABIT_TEXT_MAX_LENGTH).optional(),
    replacementAction: singleLineText(HABIT_TEXT_MAX_LENGTH).nullable().optional(),
    schedule: habitScheduleInputSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.purpose !== undefined ||
      value.cue !== undefined ||
      value.minimumAction !== undefined ||
      value.replacementAction !== undefined ||
      value.schedule !== undefined,
    { message: "変更する項目を 1 つ以上指定してください", path: ["_root"] },
  );
export type UpdateHabitRequest = z.infer<typeof updateHabitRequestSchema>;

export const archiveHabitRequestSchema = z.object({ version: habitVersionSchema }).strict();
export type ArchiveHabitRequest = z.infer<typeof archiveHabitRequestSchema>;

export const listHabitsQuerySchema = z
  .object({
    status: habitStatusSchema.default("active"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(HABIT_LIST_MAX_LIMIT)
      .default(HABIT_LIST_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(HABIT_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();
export type ListHabitsQuery = z.infer<typeof listHabitsQuerySchema>;

export const habitScheduleVersionResponseSchema = z.object({
  effectiveFrom: calendarDateSchema,
  effectiveTo: calendarDateSchema.nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)),
  targetCount: z.number().int().min(1),
});

export const habitResponseSchema = z.object({
  id: z.uuid(),
  kind: habitKindSchema,
  name: z.string(),
  purpose: z.string(),
  cue: z.string(),
  minimumAction: z.string(),
  replacementAction: z.string().nullable(),
  status: habitStatusSchema,
  version: habitVersionSchema,
  scheduleVersions: z.array(habitScheduleVersionResponseSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type HabitResponse = z.infer<typeof habitResponseSchema>;

export const habitListResponseSchema = z.object({
  items: z.array(habitResponseSchema),
  nextCursor: z.string().nullable(),
});
export type HabitListResponse = z.infer<typeof habitListResponseSchema>;
