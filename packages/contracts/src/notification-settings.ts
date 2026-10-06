import { z } from "zod";

/**
 * `/api/v1/notification-settings` の契約(docs/specs/notification-preferences.md API and Events 節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。request は `.strict()` で未知キーを拒否する。
 *
 * 時刻の意味(`HH:mm` の範囲、quiet hours の整合、timezone の IANA 検証)は Domain の
 * `resolveNotificationPreference` が判定する。ここでは型と形式のみを検証する。
 */
const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm 形式で指定してください");

const quietHoursSchema = z.object({ start: localTimeSchema, end: localTimeSchema }).strict();

export const upsertNotificationSettingsRequestSchema = z
  .object({
    enabled: z.boolean(),
    localTime: localTimeSchema,
    /** 省略は既定値、null は quiet hours なし。 */
    quietHours: quietHoursSchema.nullable().optional(),
    /** 省略はプロフィールの timezone。 */
    timezone: z.string().max(64).optional(),
  })
  .strict();
export type UpsertNotificationSettingsRequest = z.infer<
  typeof upsertNotificationSettingsRequestSchema
>;

export const notificationSettingsResponseSchema = z.object({
  enabled: z.boolean(),
  localTime: localTimeSchema,
  timezone: z.string(),
  quietHours: quietHoursSchema.nullable(),
  /** 未保存の既定値は null。 */
  updatedAt: z.iso.datetime().nullable(),
});
export type NotificationSettingsResponse = z.infer<typeof notificationSettingsResponseSchema>;
