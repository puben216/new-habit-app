import { z } from "zod";

/**
 * `/api/v1/admin/*` の契約(docs/specs/minimal-admin.md APIとイベント節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。request は `.strict()` で未知キーを拒否し、
 * 応答は項目の allowlist(個人情報・入出力を載せる余地を作らない)。
 */

/** MFA 検証 request の body 上限(バイト)。 */
export const ADMIN_REQUEST_BODY_MAX_BYTES = 1024;

/**
 * `code` は文字列であることだけを検証する。形式(6 桁/リカバリーコード)の誤りは、
 * 形式を oracle にしないため Domain の `parseMfaCode` が「無効なコード」(403)として扱う。
 */
export const adminMfaVerifyRequestSchema = z.object({ code: z.string().max(64) }).strict();
export type AdminMfaVerifyRequest = z.infer<typeof adminMfaVerifyRequestSchema>;

export const adminMfaVerifyResponseSchema = z.object({ status: z.literal("verified") });
export type AdminMfaVerifyResponse = z.infer<typeof adminMfaVerifyResponseSchema>;

export const adminMeResponseSchema = z.object({
  adminPublicId: z.uuid(),
  mfaVerified: z.boolean(),
  mfaExpiresAt: z.iso.datetime().nullable(),
});
export type AdminMeResponse = z.infer<typeof adminMeResponseSchema>;

/** email の完全一致検索。形式不正・254 文字超は 422。 */
export const adminUserSearchQuerySchema = z
  .object({ email: z.string().trim().min(1).max(254).pipe(z.email()) })
  .strict();
export type AdminUserSearchQuery = z.infer<typeof adminUserSearchQuerySchema>;

export const adminUserPublicIdSchema = z.uuid();

const userStatusSchema = z.string().min(1).max(32);

export const adminUserSearchResponseSchema = z.object({
  items: z.array(
    z.object({
      publicId: z.uuid(),
      emailMasked: z.string(),
      status: userStatusSchema,
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type AdminUserSearchResponse = z.infer<typeof adminUserSearchResponseSchema>;

const countsSchema = z.record(z.string(), z.number().int().nonnegative());

export const adminUserOverviewResponseSchema = z.object({
  publicId: z.uuid(),
  emailMasked: z.string(),
  status: userStatusSchema,
  createdAt: z.iso.datetime(),
  emailVerified: z.boolean(),
  notification: z.object({ suppressed: z.boolean(), deliveries: countsSchema }),
  aiJobs: countsSchema,
});
export type AdminUserOverviewResponse = z.infer<typeof adminUserOverviewResponseSchema>;

export const NOTIFICATION_FAILURE_STATUSES = ["failed", "expired", "suppressed"] as const;
export const AI_JOB_FAILURE_STATUSES = ["failed", "fallback"] as const;

export const ADMIN_LIST_DEFAULT_LIMIT = 20;
export const ADMIN_LIST_MAX_LIMIT = 50;

/** keyset の cursor は直前ページ最後の ID(十進文字列)のみ。 */
const cursorSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);

function listQuerySchema<const S extends readonly [string, ...string[]]>(statuses: S) {
  return z
    .object({
      status: z.enum(statuses).optional(),
      limit: z.coerce.number().int().min(1).max(ADMIN_LIST_MAX_LIMIT).optional(),
      cursor: cursorSchema.optional(),
    })
    .strict();
}

export const adminNotificationFailuresQuerySchema = listQuerySchema(NOTIFICATION_FAILURE_STATUSES);
export type AdminNotificationFailuresQuery = z.infer<typeof adminNotificationFailuresQuerySchema>;
export const adminAiJobFailuresQuerySchema = listQuerySchema(AI_JOB_FAILURE_STATUSES);
export type AdminAiJobFailuresQuery = z.infer<typeof adminAiJobFailuresQuerySchema>;

export const adminNotificationFailuresResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      userPublicId: z.uuid(),
      status: z.enum(NOTIFICATION_FAILURE_STATUSES),
      failureCode: z.string().nullable(),
      attemptCount: z.number().int().nonnegative(),
      scheduledAt: z.iso.datetime(),
      localDate: z.iso.date(),
      updatedAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type AdminNotificationFailuresResponse = z.infer<
  typeof adminNotificationFailuresResponseSchema
>;

export const adminAiJobFailuresResponseSchema = z.object({
  items: z.array(
    z.object({
      publicId: z.uuid(),
      userPublicId: z.uuid(),
      kind: z.string(),
      status: z.enum(AI_JOB_FAILURE_STATUSES),
      failureCode: z.string().nullable(),
      provider: z.string(),
      model: z.string(),
      promptVersion: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type AdminAiJobFailuresResponse = z.infer<typeof adminAiJobFailuresResponseSchema>;
