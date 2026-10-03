import { z } from "zod";

/**
 * `GET/PATCH /api/v1/me` の契約(docs/specs/user-profile.md API and Events 節)。
 *
 * 値域・許可リスト(表示名の文字種、タイムゾーン、locale、週の開始曜日)の正本は Domain
 * (`@habit-app/domain` の identity)であり、ここでは形・型・入力上限のみを定義する
 * (二重定義による乖離を避ける)。`.strict()` で未知キーを拒否する(mass assignment 防止)。
 */

/** PATCH body の最大 byte 数(Route Handler が parse 前に適用する)。 */
export const UPDATE_PROFILE_MAX_BODY_BYTES = 4096;

export const updateProfileRequestSchema = z
  .object({
    displayName: z.string().max(200),
    timezone: z.string().max(64),
    locale: z.string().max(16),
    weekStartsOn: z.number().int(),
  })
  .partial()
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "更新する項目を1つ以上指定してください",
  });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const profileResponseSchema = z.object({
  displayName: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  weekStartsOn: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
