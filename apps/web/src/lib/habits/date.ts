/**
 * プロフィールの timezone における「今日」の暦日(`YYYY-MM-DD`)。習慣の適用開始日の既定値に使う
 * (docs/specs/habit-api.md HAPI-001: ローカル日付は client が指定する)。表示用の整形のみで業務判定はしない。
 */
export function todayInTimezone(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    calendar: "gregory",
    numberingSystem: "latn",
  }).format(now);
}
