import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";

/**
 * アカウント削除画面の固定文言(docs/specs/account-deletion.md ACD-007、WUI-INV-003:
 * server の文字列は描画しない)。
 */
export const REAUTH_FAILED_MESSAGE = "パスワードが正しくありません。もう一度入力してください。";
export const TOO_MANY_ATTEMPTS_MESSAGE =
  "試行回数の上限に達しました。しばらく待ってからもう一度お試しください。";
export const PASSWORD_REQUIRED_MESSAGE = "パスワードを入力してください。";
export const GRACE_EXPIRED_MESSAGE =
  "猶予期間を過ぎているため、取り消せません。削除の処理が完了するまでお待ちください。";
export const NETWORK_MESSAGE = "通信に失敗しました。時間をおいてもう一度お試しください。";
export const UNEXPECTED_MESSAGE =
  "処理を完了できませんでした。時間をおいてもう一度お試しください。";
export type AccountErrorKind =
  "reauth_failed" | "too_many_attempts" | "grace_expired" | "not_active" | "network" | "unexpected";

/** API 失敗の分類。使うのは status と code だけで、server の文字列は使わない。 */
export function classifyAccountError(error: unknown): AccountErrorKind {
  if (!isApiError(error)) return "unexpected";
  if (error.code === CLIENT_ERROR_CODES.networkError) return "network";
  if (error.status === 403 && error.code === "reauthentication_failed") return "reauth_failed";
  if (error.status === 429 && error.code === "too_many_attempts") return "too_many_attempts";
  if (error.status === 409 && error.code === "grace_period_expired") return "grace_expired";
  if (error.status === 409) return "not_active";
  return "unexpected";
}

export function accountErrorMessage(kind: AccountErrorKind): string {
  switch (kind) {
    case "reauth_failed":
      return REAUTH_FAILED_MESSAGE;
    case "too_many_attempts":
      return TOO_MANY_ATTEMPTS_MESSAGE;
    case "grace_expired":
      return GRACE_EXPIRED_MESSAGE;
    case "network":
      return NETWORK_MESSAGE;
    case "not_active":
    case "unexpected":
      return UNEXPECTED_MESSAGE;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
