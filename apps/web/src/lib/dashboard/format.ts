/**
 * ダッシュボードの表示用整形(docs/specs/dashboard-screen.md DSH-INV-001/002)。
 * 集計値は server が計算済みで、ここでは再計算せず表示用に整えるだけ。
 */

/** 成功率を整数%にする。`null`(分母 0)は 0% と区別する。 */
export function formatRate(rate: number | null): string {
  if (rate === null) return "まだ集計できません";
  let percent = Math.round(rate * 100);
  // 実際の状態を誤解させない: 全成功でなければ 100%、少しでも成功があれば 0% にしない。
  if (rate < 1 && percent >= 100) percent = 99;
  if (rate > 0 && percent <= 0) percent = 1;
  return `${percent}%`;
}

/** `meter` 用の値(0〜100)。`null` は 0。 */
export function rateMeterValue(rate: number | null): number {
  return rate === null ? 0 : Math.min(100, Math.max(0, Math.round(rate * 100)));
}

function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function formatPeriod(from: string, to: string): string {
  return `${shortDate(from)}〜${shortDate(to)}`;
}

/** ストリークは控えめな文言にする(単位は予定された機会の数)。 */
export function streakText(current: number, longest: number): string {
  return `現在 ${current} 回連続(最長 ${longest} 回)`;
}
