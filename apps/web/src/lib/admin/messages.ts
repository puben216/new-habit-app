import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";

/** 管理画面の固定文言(docs/specs/admin-screens.md ADS-INV-004: server の文字列は描画しない)。 */
export const MFA_INVALID_MESSAGE = "コードが正しくありません。もう一度入力してください。";
export const MFA_LOCKED_MESSAGE =
  "試行回数の上限に達しました。しばらく待ってからもう一度お試しください。";
export const NETWORK_MESSAGE = "通信に失敗しました。時間をおいてもう一度お試しください。";
export const UNEXPECTED_MESSAGE =
  "処理を完了できませんでした。時間をおいてもう一度お試しください。";
export const EMAIL_INVALID_MESSAGE = "メールアドレスの形式を確認してください。";
export const NOT_FOUND_MESSAGE = "見つかりません";

export type AdminErrorKind =
  | "mfa_invalid"
  | "mfa_locked"
  | "mfa_required"
  | "not_found"
  | "invalid_input"
  | "network"
  | "unexpected";

/** API 失敗の分類。使うのは status と code だけで、server の文字列は使わない。 */
export function classifyAdminError(error: unknown): AdminErrorKind {
  if (!isApiError(error)) return "unexpected";
  if (error.code === CLIENT_ERROR_CODES.networkError) return "network";
  // 不正な ID(path として許可されない値)も、存在しない対象と同じ扱いにする。
  if (error.code === CLIENT_ERROR_CODES.invalidRequestPath) return "not_found";
  if (error.status === 429 && error.code === "mfa_locked") return "mfa_locked";
  if (error.status === 403 && error.code === "invalid_mfa_code") return "mfa_invalid";
  if (error.status === 403 && error.code === "mfa_required") return "mfa_required";
  if (error.status === 404) return "not_found";
  if (error.status === 422) return "invalid_input";
  return "unexpected";
}

export function mfaErrorMessage(kind: AdminErrorKind): string {
  switch (kind) {
    case "mfa_invalid":
      return MFA_INVALID_MESSAGE;
    case "mfa_locked":
      return MFA_LOCKED_MESSAGE;
    case "network":
      return NETWORK_MESSAGE;
    case "mfa_required":
    case "not_found":
    case "invalid_input":
    case "unexpected":
      return UNEXPECTED_MESSAGE;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
