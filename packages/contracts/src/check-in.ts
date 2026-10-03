import { z } from "zod";

/**
 * `/api/v1/daily-check-ins/{date}` の契約(docs/specs/daily-check-in.md API and Events 節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。request は `.strict()` で未知キーを拒否する。
 *
 * メモの文字数上限は docs/10-decisions-and-open-questions.md の P2 が未決のため暫定値
 * (docs/specs/daily-check-in.md DCI-INV-004)。確定後はこの定数だけを変更する。
 */
export const CHECK_IN_NOTE_MAX_LENGTH = 1000;

/** 改行(\n)とタブ(\t)は許可し、それ以外の制御文字(NUL を含む)を拒否する。 */
function hasDisallowedControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x09) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const scaleSchema = z.number().int().min(1).max(5);
const calendarDateSchema = z.iso.date();

/** path の `{date}`。実在する暦日の `YYYY-MM-DD`。 */
export const checkInDateParamSchema = calendarDateSchema;

/**
 * 「少なくとも 1 項目」などの組み合わせ検証は Domain の `resolveDailyCheckIn` が行う。
 * ここでは型と値域、メモの長さ・制御文字のみを検証する。
 */
export const upsertDailyCheckInRequestSchema = z
  .object({
    mood: scaleSchema.nullable().optional(),
    difficulty: scaleSchema.nullable().optional(),
    note: z
      .string()
      .max(CHECK_IN_NOTE_MAX_LENGTH)
      .refine((value) => !hasDisallowedControlCharacter(value), {
        message: "制御文字は使用できません",
      })
      .nullable()
      .optional(),
  })
  .strict();
export type UpsertDailyCheckInRequest = z.infer<typeof upsertDailyCheckInRequestSchema>;

export const dailyCheckInResponseSchema = z.object({
  date: calendarDateSchema,
  mood: scaleSchema.nullable(),
  difficulty: scaleSchema.nullable(),
  note: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type DailyCheckInResponse = z.infer<typeof dailyCheckInResponseSchema>;
