/**
 * フォーム入力の最小限の検証(docs/specs/auth-screens.md AUI-002、AUI-INV-005)。
 *
 * UX のための「必須・上限・形式の目安」だけを判定する。password policy(最小文字数・制御文字)、
 * email の厳密な形式、token の有効性は server が判定する。戻り値は種別で、文言は持たない。
 */
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MAX_LENGTH = 128;
export const TOKEN_MAX_LENGTH = 512;

export type ValidationIssue = "required" | "too_long" | "format";

export function validateEmail(value: string): ValidationIssue | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "required";
  if (trimmed.length > EMAIL_MAX_LENGTH) return "too_long";
  // 目安のみ: `@` の前後に空白を含まない文字がある。
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmed)) return "format";
  return null;
}

/** password は先頭・末尾の空白も値の一部(AUTH-002)。空白のみの入力だけを未入力として扱う。 */
export function validatePassword(value: string): ValidationIssue | null {
  if (value.trim().length === 0) return "required";
  if (value.length > PASSWORD_MAX_LENGTH) return "too_long";
  return null;
}

export function validateToken(value: string): ValidationIssue | null {
  if (value.length === 0) return "required";
  if (value.length > TOKEN_MAX_LENGTH) return "too_long";
  return null;
}
