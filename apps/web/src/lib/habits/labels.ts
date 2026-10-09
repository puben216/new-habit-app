const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
export const DAY_NAMES = [
  "日曜日",
  "月曜日",
  "火曜日",
  "水曜日",
  "木曜日",
  "金曜日",
  "土曜日",
] as const;

export function kindLabel(kind: "build" | "reduce"): string {
  return kind === "build" ? "身につけたい習慣" : "減らしたい習慣";
}

/** 曜日の要約。7 日すべてなら「毎日」、それ以外は日曜始まりの順に「月・水・金」。 */
export function summarizeDays(daysOfWeek: readonly number[]): string {
  const days = [...new Set(daysOfWeek)].sort((a, b) => a - b);
  if (days.length === 7) return "毎日";
  if (days.length === 0) return "なし";
  return days.map((day) => DAY_LABELS[day] ?? "?").join("・");
}
