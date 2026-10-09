const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** 十進文字列の ID を bigint へ。形式不正・範囲外は `null`(何にも到達できない扱い)。 */
export function parseBigintId(value: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_BIGINT ? parsed : null;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function calendarDateFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dateFromCalendarDate(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}
