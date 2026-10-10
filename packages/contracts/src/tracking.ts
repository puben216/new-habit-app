import { z } from "zod";

/**
 * `/api/v1/schedule/today` と `/api/v1/habits/{habitId}/entries/{date}` の契約
 * (docs/specs/habit-entry.md API and Events 節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。request は `.strict()` で未知キーを拒否する。
 * quantity の上限は Domain の HABIT_ENTRY_MAX_QUANTITY と DB の CHECK 制約と同じ値(1000)。
 */
export const HABIT_ENTRY_MAX_QUANTITY = 1000;

const habitEntryStatusSchema = z.enum(["success", "missed", "skipped"]);
const calendarDateSchema = z.iso.date();

/** path の `{date}`。実在する暦日の `YYYY-MM-DD`。 */
export const habitEntryDateParamSchema = calendarDateSchema;

/**
 * `quantity` の組み合わせ(kind/targetCount に依存する検証)は Domain の `resolveHabitEntry` が行う。
 * ここでは型と値域のみを検証する。
 */
export const upsertHabitEntryRequestSchema = z
  .object({
    status: habitEntryStatusSchema,
    quantity: z.number().int().min(0).max(HABIT_ENTRY_MAX_QUANTITY).nullable().optional(),
  })
  .strict();
export type UpsertHabitEntryRequest = z.infer<typeof upsertHabitEntryRequestSchema>;

export const habitEntryResponseSchema = z.object({
  habitId: z.uuid(),
  date: calendarDateSchema,
  status: habitEntryStatusSchema,
  quantity: z.number().int().min(0).nullable(),
  updatedAt: z.iso.datetime(),
});
export type HabitEntryResponse = z.infer<typeof habitEntryResponseSchema>;

export const todayScheduleResponseSchema = z.object({
  date: calendarDateSchema,
  timezone: z.string(),
  /** 記録を補正できる最も古い暦日(今日から過去 7 日前)。 */
  earliestDate: calendarDateSchema,
  items: z.array(
    z.object({
      habit: z.object({
        id: z.uuid(),
        kind: z.enum(["build", "reduce"]),
        name: z.string(),
        cue: z.string(),
        minimumAction: z.string(),
        replacementAction: z.string().nullable(),
      }),
      targetCount: z.number().int().min(1),
      entry: z
        .object({
          status: habitEntryStatusSchema,
          quantity: z.number().int().min(0).nullable(),
          updatedAt: z.iso.datetime(),
        })
        .nullable(),
    }),
  ),
});
export type TodayScheduleResponse = z.infer<typeof todayScheduleResponseSchema>;
