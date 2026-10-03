import { InvalidScheduleCalculationInputError } from "./errors";

/**
 * `instant` を IANA `timezone` で解釈したときのローカル暦日(`YYYY-MM-DD`)を返す。
 *
 * 日付の境界は timezone の壁時計の 0 時で決まるため、DST による 23/25 時間日でも
 * 1 暦日が 1 件に対応する。timezone ID の形式検証(`parseTimezone`)は呼び出し側
 * (Profile の保存時)の責務であり、ここでは ICU が受理しない値のみを拒否する。
 */
export function localDateAt(instant: Date, timezone: string): string {
  if (Number.isNaN(instant.getTime())) {
    throw new InvalidScheduleCalculationInputError("instant が不正な日時です。");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      calendar: "gregory",
      numberingSystem: "latn",
    });
  } catch {
    throw new InvalidScheduleCalculationInputError("timezone が不正です。");
  }
  const parts = formatter.formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) {
      throw new InvalidScheduleCalculationInputError(`${type} を解決できませんでした。`);
    }
    return part.value;
  };
  return `${pick("year").padStart(4, "0")}-${pick("month")}-${pick("day")}`;
}
