import { parseTimezone } from "../identity/timezone";
import { InvalidNotificationPreferenceError, ReminderTimeInQuietHoursError } from "./errors";

/**
 * 既定値(docs/specs/notification-preferences.md NPF-INV-007)。
 * docs/10 の P2(quiet hours の既定値)が確定するまでの暫定値で、確定後はこの定数だけを変更する。
 */
export const DEFAULT_REMINDER_LOCAL_TIME = "20:00";
export const DEFAULT_QUIET_HOURS: QuietHours = { start: "22:00", end: "07:00" };

/** 区間は `[start, end)`。`start > end` は日跨ぎ(例: 22:00〜07:00)を表す。 */
export interface QuietHours {
  readonly start: string;
  readonly end: string;
}

export interface NotificationPreferenceInput {
  readonly enabled: boolean;
  readonly localTime: string;
  /** `undefined` は既定値、`null` は quiet hours なし。 */
  readonly quietHours?: QuietHours | null | undefined;
  /** `undefined` の場合は `defaultTimezone` を使う。 */
  readonly timezone?: string | undefined;
}

export interface ResolvedNotificationPreference {
  readonly enabled: boolean;
  readonly localTime: string;
  readonly timezone: string;
  readonly quietHours: QuietHours | null;
}

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:mm`(24 時間、分単位)か。秒付き・1 桁の時は不可。 */
export function isLocalTime(value: unknown): value is string {
  return typeof value === "string" && LOCAL_TIME_PATTERN.test(value);
}

function minutesOfDay(localTime: string): number {
  const hours = Number(localTime.slice(0, 2));
  const minutes = Number(localTime.slice(3, 5));
  return hours * 60 + minutes;
}

/**
 * ローカル時刻が quiet hours に含まれるか。区間は `[start, end)`、日跨ぎに対応する。
 * T-402(送信予定の生成)が再利用する純粋関数。`HH:mm` 以外の入力は呼び出し側が検証済みである前提。
 */
export function isWithinQuietHours(localTime: string, quietHours: QuietHours): boolean {
  const time = minutesOfDay(localTime);
  const start = minutesOfDay(quietHours.start);
  const end = minutesOfDay(quietHours.end);
  if (start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

/**
 * 通知設定を検証・正規化する(docs/specs/notification-preferences.md NPF-003)。
 *
 * @param defaultTimezone `timezone` 省略時に使うプロフィールの timezone(検証済みの値)
 * @throws {InvalidNotificationPreferenceError} 時刻・timezone・quiet hours が不正
 * @throws {ReminderTimeInQuietHoursError} `enabled` で送信時刻が quiet hours 内
 */
export function resolveNotificationPreference(
  input: NotificationPreferenceInput,
  defaultTimezone: string,
): ResolvedNotificationPreference {
  if (!isLocalTime(input.localTime)) {
    throw new InvalidNotificationPreferenceError(
      "localTime",
      "localTime は HH:mm 形式(00:00〜23:59)で指定してください。",
    );
  }

  const timezone = parseTimezone(input.timezone ?? defaultTimezone);
  if (timezone === null) {
    throw new InvalidNotificationPreferenceError(
      "timezone",
      "timezone は IANA タイムゾーン ID で指定してください。",
    );
  }

  const quietHours = input.quietHours === undefined ? DEFAULT_QUIET_HOURS : input.quietHours;
  if (quietHours !== null) {
    if (!isLocalTime(quietHours.start) || !isLocalTime(quietHours.end)) {
      throw new InvalidNotificationPreferenceError(
        "quietHours",
        "quietHours は HH:mm 形式で指定してください。",
      );
    }
    if (quietHours.start === quietHours.end) {
      throw new InvalidNotificationPreferenceError(
        "quietHours",
        "quietHours の開始と終了は異なる時刻にしてください。",
      );
    }
  }

  if (input.enabled && quietHours !== null && isWithinQuietHours(input.localTime, quietHours)) {
    throw new ReminderTimeInQuietHoursError();
  }

  return {
    enabled: input.enabled,
    localTime: input.localTime,
    timezone,
    quietHours: quietHours === null ? null : { start: quietHours.start, end: quietHours.end },
  };
}
