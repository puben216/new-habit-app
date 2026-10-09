export const DISPLAY_NAME_MAX_LENGTH = 50;

export type DisplayNameIssue = "required" | "too_long";

/**
 * 表示名の UX 検証(必須と 50 文字上限の目安)。文字数は code point で数える(server と同じ)。
 * 文字種(制御文字・双方向制御文字)の判定は server(Domain)に任せる。
 */
export function validateDisplayName(value: string): DisplayNameIssue | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "required";
  if (Array.from(trimmed.normalize("NFC")).length > DISPLAY_NAME_MAX_LENGTH) return "too_long";
  return null;
}
