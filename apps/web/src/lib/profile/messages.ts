import type { DisplayNameIssue } from "./validation";

/** プロフィール画面の固定文言(WUI-INV-003: server の文字列は描画しない)。 */
export type ProfileField = "displayName" | "timezone" | "weekStartsOn";

export const PROFILE_SAVED_MESSAGE = "保存しました。";
export const PROFILE_LOAD_FAILED_MESSAGE = "プロフィールを読み込めませんでした。";
export const PROFILE_FORM_INVALID_MESSAGE = "入力内容を確認してください。";
export const PROFILE_NETWORK_MESSAGE = "通信に失敗しました。時間をおいてもう一度お試しください。";
export const PROFILE_UNEXPECTED_MESSAGE =
  "保存できませんでした。時間をおいてもう一度お試しください。";

export function displayNameIssueMessage(issue: DisplayNameIssue): string {
  return issue === "required"
    ? "表示名を入力してください。"
    : "表示名は50文字以内で入力してください。";
}

const SERVER_REJECTED: Record<ProfileField, string> = {
  displayName: "表示名に使用できない文字が含まれているか、長さが範囲外です。",
  timezone: "タイムゾーンを選び直してください。",
  weekStartsOn: "週の開始曜日を選び直してください。",
};

/** `fieldErrors` のキーだけを使い、対応する項目の固定文言を返す。 */
export function mapProfileFieldErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined,
): { fields: Partial<Record<ProfileField, string>>; form: string | null } {
  const fields: Partial<Record<ProfileField, string>> = {};
  for (const field of Object.keys(SERVER_REJECTED) as ProfileField[]) {
    if (fieldErrors?.[field] !== undefined) fields[field] = SERVER_REJECTED[field];
  }
  return {
    fields,
    form: Object.keys(fields).length > 0 ? null : PROFILE_FORM_INVALID_MESSAGE,
  };
}

export const WEEKDAY_LABELS = [
  "日曜日",
  "月曜日",
  "火曜日",
  "水曜日",
  "木曜日",
  "金曜日",
  "土曜日",
] as const;
