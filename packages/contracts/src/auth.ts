import { z } from "zod";

/**
 * `/api/v1/auth/*` の request body 契約(docs/specs/auth-adapter.md API and Events 節)。
 * `.strict()` で未知キーを拒否する(共通仕様)。
 *
 * resend/password-reset request の email は形式チェックを行わない(AUTH-INV-002)。
 * 形式に関わらず use case 側の normalizeEmail + lookup が自然に 202(未登録時は no-op)を
 * 返すため、ここで形式エラーを分けて返すと「明らかに email 形式ではない文字列」と
 * 「形式は正しいが未登録」を区別する新たな判定軸を作ってしまう。signup のみ、
 * State Transitions/API 節が明示的に 422(email 形式不正)を要求するため `.email()` を適用する。
 */

export const signUpRequestSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().max(128),
  })
  .strict();
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

export const verifyEmailRequestSchema = z
  .object({
    token: z.string().max(512),
  })
  .strict();
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const resendVerificationRequestSchema = z
  .object({
    email: z.string().max(254),
  })
  .strict();
export type ResendVerificationRequest = z.infer<typeof resendVerificationRequestSchema>;

export const passwordResetRequestSchema = z
  .object({
    email: z.string().max(254),
  })
  .strict();
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmRequestSchema = z
  .object({
    token: z.string().max(512),
    newPassword: z.string().max(128),
  })
  .strict();
export type PasswordResetConfirmRequest = z.infer<typeof passwordResetConfirmRequestSchema>;

/** zod の validation issue を Problem Details の fieldErrors 形式に変換する。 */
export function toFieldErrors(issues: ReadonlyArray<z.core.$ZodIssue>): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_root";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}
