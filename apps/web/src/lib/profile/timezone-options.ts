/**
 * タイムゾーン選択肢の構築(docs/specs/profile-screens.md PFS-004)。
 * 妥当性の最終判定は server(Domain)。ここは表示用の一覧を作るだけで、現在値と UTC を必ず含める。
 */
export function buildTimezoneOptions(supported: readonly string[], current: string): string[] {
  const unique = new Set<string>(supported);
  unique.add("UTC");
  unique.add(current);
  return [...unique].sort((a, b) => a.localeCompare(b, "en"));
}

/** ブラウザのタイムゾーンが選択肢にあればそれ、なければ現在値。 */
export function pickInitialTimezone(
  detected: string | undefined,
  options: readonly string[],
  current: string,
): string {
  return detected !== undefined && options.includes(detected) ? detected : current;
}
