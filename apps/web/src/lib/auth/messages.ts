import type { ValidationIssue } from "./validation";

/**
 * 認証画面の固定文言(docs/specs/auth-screens.md AUI-001、AUI-INV-001、AUI-INV-002)。
 * server の `message`/`fieldErrors` の文字列は描画せず、ここにある文言だけを使う。
 */
export type AuthField = "email" | "password" | "newPassword";

/** login の失敗はすべてこの 1 文言(不存在・不一致・未確認・lockout を区別しない)。 */
export const LOGIN_FAILED_MESSAGE =
  "メールアドレスまたはパスワードが正しくないか、メールアドレスの確認が完了していません。";

export const NETWORK_ERROR_MESSAGE = "通信に失敗しました。時間をおいてもう一度お試しください。";

export const UNEXPECTED_ERROR_MESSAGE =
  "処理を完了できませんでした。時間をおいてもう一度お試しください。";

export const FORM_INVALID_MESSAGE = "入力内容を確認してください。";

export const SESSION_EXPIRED_MESSAGE =
  "ログインの有効期限が切れました。もう一度ログインしてください。";

export const SIGNUP_DONE_MESSAGE =
  "確認メールを送信しました。届いていない場合は迷惑メールフォルダーもご確認ください。";

export const RESEND_DONE_MESSAGE =
  "入力されたメールアドレス宛に、確認メールを送信しました(登録がある場合)。届いていない場合は迷惑メールフォルダーもご確認ください。";

export const PASSWORD_RESET_REQUESTED_MESSAGE =
  "入力されたメールアドレス宛に、再設定の案内を送信しました(登録がある場合)。";

export const INVALID_LINK_MESSAGE = "リンクが無効、または期限が切れています。";

const FIELD_LABEL: Record<AuthField, string> = {
  email: "メールアドレス",
  password: "パスワード",
  newPassword: "新しいパスワード",
};

const FIELD_MAX: Record<AuthField, string> = {
  email: "254文字",
  password: "128文字",
  newPassword: "128文字",
};

/** クライアント検証の結果を固定文言にする。 */
export function issueMessage(field: AuthField, issue: ValidationIssue): string {
  const label = FIELD_LABEL[field];
  switch (issue) {
    case "required":
      return `${label}を入力してください。`;
    case "too_long":
      return `${label}は${FIELD_MAX[field]}以内で入力してください。`;
    case "format":
      return `${label}の形式を確認してください。`;
    default: {
      const unreachable: never = issue;
      return unreachable;
    }
  }
}

/** server が項目を拒否したとき(422)の固定文言。 */
export function serverRejectedMessage(field: AuthField): string {
  return field === "email"
    ? "メールアドレスの形式を確認してください。"
    : `${FIELD_LABEL[field]}の条件を満たしていません。8文字以上128文字以内で入力してください。`;
}

export interface MappedFieldErrors {
  readonly fields: Partial<Record<AuthField, string>>;
  /** 対応する項目がない(未知のキーのみ)場合のフォーム全体のエラー。 */
  readonly form: string | null;
}

/**
 * Problem Details の `fieldErrors` を固定文言へ変換する。使うのはキー(どの項目か)だけで、
 * server が返した文字列は使わない。
 */
export function mapFieldErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined,
  allowed: readonly AuthField[],
): MappedFieldErrors {
  const fields: Partial<Record<AuthField, string>> = {};
  for (const field of allowed) {
    if (fieldErrors?.[field] !== undefined) fields[field] = serverRejectedMessage(field);
  }
  const hasKnown = Object.keys(fields).length > 0;
  return { fields, form: hasKnown ? null : FORM_INVALID_MESSAGE };
}
