/** 週の開始曜日。0=日曜〜6=土曜(docs/specs/user-profile.md PROF-005)。 */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function isWeekStartsOn(value: unknown): value is WeekStartsOn {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}
