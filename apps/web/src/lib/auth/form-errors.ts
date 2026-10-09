import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";

import {
  NETWORK_ERROR_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  mapFieldErrors,
  type AuthField,
  type MappedFieldErrors,
} from "./messages";

/**
 * API 失敗をフォームのエラー表示(固定文言)に変換する(docs/specs/auth-screens.md AUI-001)。
 * 使うのは status・code・fieldErrors のキーだけで、server の文字列は使わない。
 */
export function describeFormError(
  error: unknown,
  allowed: readonly AuthField[],
): MappedFieldErrors {
  if (!isApiError(error)) return { fields: {}, form: UNEXPECTED_ERROR_MESSAGE };
  if (error.code === CLIENT_ERROR_CODES.networkError) {
    return { fields: {}, form: NETWORK_ERROR_MESSAGE };
  }
  if (error.status === 422) return mapFieldErrors(error.fieldErrors, allowed);
  return { fields: {}, form: UNEXPECTED_ERROR_MESSAGE };
}

/** token が無効/期限切れ(`400 invalid_or_expired_token`)か。理由は区別しない。 */
export function isInvalidTokenError(error: unknown): boolean {
  return isApiError(error) && error.status === 400 && error.code === "invalid_or_expired_token";
}
