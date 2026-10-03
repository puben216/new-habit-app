export const TIMEZONE_MAX_LENGTH = 64;

/**
 * IANA ID の形。各セグメントは英大文字で始まる(例: Asia/Tokyo、America/Argentina/Buenos_Aires)。
 * UTC オフセット表記(`+09:00`)や小文字始まりの値はここで除外される。
 */
const TIMEZONE_SHAPE = /^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)*$/;

/**
 * IANA タイムゾーン ID を検証する(docs/specs/user-profile.md PROF-004)。
 *
 * 保存した ID は後続の予定機会計算(T-201 以降)が `Intl` で解釈するため、実行環境の ICU が
 * 受理することを検証条件にする。ICU の正規 ID は旧名(例: `Asia/Katmandu`)を返すことがあり、
 * ブラウザが送る現行名(`Asia/Kathmandu`)を拒否してしまうため、ID の正規化(置換)は行わず、
 * 検証済みの入力をそのまま返す。
 *
 * - 空文字、64 文字超、IANA ID の形に合わない文字列は拒否する
 * - `Area/Location` 形式(スラッシュを含む)または `UTC` のみ許可する。
 *   ICU が受理する略称(`JST`、`EST`、`GMT` 等。`EST` は別地域へ解決されるなど曖昧)は拒否する
 * - 大文字小文字だけが異なる誤記(`America/New_york`)は拒否する(ICU が別名ではなく
 *   同一 ID の大文字小文字違いとして解決した場合)
 *
 * @returns 検証済みの ID(入力と同一)。不正なら `null`
 */
export function parseTimezone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.length < 1 || input.length > TIMEZONE_MAX_LENGTH) return null;
  if (!TIMEZONE_SHAPE.test(input)) return null;
  if (input !== "UTC" && !input.includes("/")) return null;

  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: input }).resolvedOptions().timeZone;
  } catch {
    return null;
  }

  // 同一 ID の大文字小文字違い(別名ではない)は、正規の綴りと一致しない誤記として拒否する。
  if (resolved.toLowerCase() === input.toLowerCase() && resolved !== input) return null;

  return input;
}
