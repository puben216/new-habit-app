import { z } from "zod";

/**
 * `DELETE /api/v1/me`、`GET /api/v1/me/deletion`、`POST /api/v1/me/deletion/cancel` の契約
 * (docs/specs/account-deletion.md APIとイベント節)。runtime schema を正本とし、型は z.infer で導出する(ADR-009)。
 * request は `.strict()` で未知キーを拒否する。
 */

/** `DELETE /me` の body 上限(バイト)。パスワードのみのため小さい。 */
export const ACCOUNT_DELETION_REQUEST_MAX_BODY_BYTES = 1024;

/** AUTH-002 のパスワード上限と同じ。形式の詳細は検証せず、ハッシュの照合に任せる。 */
export const REAUTH_PASSWORD_MAX_LENGTH = 128;

export const requestAccountDeletionRequestSchema = z
  .object({ password: z.string().min(1).max(REAUTH_PASSWORD_MAX_LENGTH) })
  .strict();
export type RequestAccountDeletionRequest = z.infer<typeof requestAccountDeletionRequestSchema>;

export const accountDeletionRequestedResponseSchema = z.object({
  status: z.literal("deletion_pending"),
  scheduledFor: z.iso.datetime(),
});
export type AccountDeletionRequestedResponse = z.infer<
  typeof accountDeletionRequestedResponseSchema
>;

export const accountDeletionStatusResponseSchema = z.object({
  status: z.enum(["active", "deletion_pending"]),
  scheduledFor: z.iso.datetime().nullable(),
});
export type AccountDeletionStatusResponse = z.infer<typeof accountDeletionStatusResponseSchema>;

export const accountDeletionCancelledResponseSchema = z.object({ status: z.literal("active") });
export type AccountDeletionCancelledResponse = z.infer<
  typeof accountDeletionCancelledResponseSchema
>;
