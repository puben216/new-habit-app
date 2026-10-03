/** 暫定の対応言語(docs/specs/user-profile.md PROF-005、10-decisions P1 未決)。DB CHECK と揃える。 */
export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
