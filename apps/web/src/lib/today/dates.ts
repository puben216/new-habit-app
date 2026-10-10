/**
 * 日付選択肢(docs/specs/today-screens.md TUI-001)。範囲(今日〜最も古い補正可能日)は server が返す値を使い、
 * ここで「7 日」を再定義しない(TUI-INV-002)。暦日は `YYYY-MM-DD` 文字列で扱い、UTC の暦日演算のみ行う。
 */
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export interface DateOption {
  readonly date: string;
  readonly label: string;
}

function parse(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  const value = parse(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dayLabel(date: string, today: string): string {
  if (date === today) return "今日";
  if (date === addDays(today, -1)) return "昨日";
  const value = parse(date);
  return `${value.getUTCMonth() + 1}/${value.getUTCDate()}(${WEEKDAYS[value.getUTCDay()]})`;
}

/** 今日から `earliest` まで、新しい順の選択肢。`earliest` が今日より後なら今日だけ。 */
export function buildDateOptions(today: string, earliest: string): DateOption[] {
  const options: DateOption[] = [];
  for (let date = today; date >= earliest; date = addDays(date, -1)) {
    options.push({ date, label: dayLabel(date, today) });
  }
  return options.length > 0 ? options : [{ date: today, label: "今日" }];
}

/** `?date=` を選択肢と照合する。一致しない(範囲外・不正・未指定)場合は今日。 */
export function parseSelectedDate(
  raw: string | readonly string[] | undefined,
  options: readonly DateOption[],
  today: string,
): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && options.some((option) => option.date === value)
    ? value
    : today;
}
