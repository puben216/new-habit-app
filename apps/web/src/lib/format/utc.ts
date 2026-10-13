/**
 * 日時の表示用の整形。利用者の端末の timezone に依存させず、UTC の固定書式で表示する
 * (docs/specs/admin-screens.md ADS-008、docs/specs/account-deletion.md ACD-007)。
 */

const ISO_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

/** ISO 8601(UTC)の日時を `YYYY-MM-DD HH:mm UTC` にする。形式が想定外なら元の文字列は出さず「不明」。 */
export function formatUtc(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "不明";
  const match = ISO_PATTERN.exec(new Date(time).toISOString());
  return match === null ? "不明" : `${match[1]} ${match[2]} UTC`;
}
