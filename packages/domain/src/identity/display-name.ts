export const DISPLAY_NAME_MAX_LENGTH = 50;

/** Cc(制御文字)、行区切り(Zl)、段落区切り(Zp)、双方向制御文字(Bidi_Control)(PROF-003)。 */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

/**
 * 表示名を検証・正規化する(docs/specs/user-profile.md PROF-003)。
 * 前後の空白を除去し NFC 正規化した文字列を返す。長さは code point 単位で 1〜50。
 *
 * @returns 正規化済みの表示名。不正なら `null`(理由は呼び出し側で固定メッセージ化する)
 */
export function parseDisplayName(input: unknown): string | null {
  if (typeof input !== "string") return null;

  const normalized = input.trim().normalize("NFC");
  if (FORBIDDEN_CHARACTERS.test(normalized)) return null;

  const length = Array.from(normalized).length;
  if (length < 1 || length > DISPLAY_NAME_MAX_LENGTH) return null;

  return normalized;
}
