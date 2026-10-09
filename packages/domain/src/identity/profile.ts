import { parseDisplayName } from "./display-name";
import { InvalidProfileError, type ProfileViolation } from "./errors";
import { isLocale, type Locale } from "./locale";
import { parseTimezone } from "./timezone";
import { isWeekStartsOn, type WeekStartsOn } from "./week-starts-on";

/** Member のプロフィール(docs/specs/user-profile.md)。`displayName` が null の間はオンボーディング未完了。 */
export interface UserProfile {
  readonly displayName: string | null;
  readonly timezone: string;
  readonly locale: Locale;
  readonly weekStartsOn: WeekStartsOn;
}

/** 検証済みの部分更新。指定された項目のみ含む。 */
export type ProfileChanges = Partial<UserProfile>;

/** 未検証の部分更新入力。各項目は `unknown` として受け、Domain が絞り込む。 */
export interface ProfileChangesInput {
  readonly displayName?: unknown;
  readonly timezone?: unknown;
  readonly locale?: unknown;
  readonly weekStartsOn?: unknown;
}

/** 暫定既定値(PROF-006。weekStartsOn と locale は 10-decisions P1 の確定時に更新する)。 */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";
export const DEFAULT_LOCALE: Locale = "ja";
export const DEFAULT_WEEK_STARTS_ON: WeekStartsOn = 1;

/**
 * オンボーディング完了の判定(docs/specs/profile-screens.md PFS-001、PROF-006)。
 * 表示名が設定済み(null でない)ことを完了とする。判定の定義はここ 1 箇所に置く。
 */
export function hasCompletedOnboarding(profile: Pick<UserProfile, "displayName">): boolean {
  return profile.displayName !== null;
}

export function createDefaultProfile(): UserProfile {
  return {
    displayName: null,
    timezone: DEFAULT_TIMEZONE,
    locale: DEFAULT_LOCALE,
    weekStartsOn: DEFAULT_WEEK_STARTS_ON,
  };
}

/**
 * 部分更新入力を検証・正規化する(PROF-002〜005)。`undefined` の項目は変更なしとして無視する。
 * 違反は最初の 1 件で止めず、すべて `InvalidProfileError.violations` にまとめる。
 * 1 項目も指定されていない場合も `_root` の違反として拒否する(契約 schema でも拒否するが、
 * Domain 単体でも空更新を許さない)。
 *
 * @throws {InvalidProfileError}
 */
export function validateProfileChanges(input: ProfileChangesInput): ProfileChanges {
  const violations: ProfileViolation[] = [];
  const changes: { -readonly [K in keyof ProfileChanges]: ProfileChanges[K] } = {};

  if (input.displayName !== undefined) {
    const displayName = parseDisplayName(input.displayName);
    if (displayName === null) {
      violations.push({
        field: "displayName",
        message: "表示名は1〜50文字で、制御文字を含めることはできません",
      });
    } else {
      changes.displayName = displayName;
    }
  }

  if (input.timezone !== undefined) {
    const timezone = parseTimezone(input.timezone);
    if (timezone === null) {
      violations.push({
        field: "timezone",
        message: "IANAタイムゾーンID(例: Asia/Tokyo)を指定してください",
      });
    } else {
      changes.timezone = timezone;
    }
  }

  if (input.locale !== undefined) {
    if (isLocale(input.locale)) {
      changes.locale = input.locale;
    } else {
      violations.push({ field: "locale", message: "サポートされていない言語です" });
    }
  }

  if (input.weekStartsOn !== undefined) {
    if (isWeekStartsOn(input.weekStartsOn)) {
      changes.weekStartsOn = input.weekStartsOn;
    } else {
      violations.push({
        field: "weekStartsOn",
        message: "週の開始曜日は0(日曜)〜6(土曜)の整数で指定してください",
      });
    }
  }

  if (violations.length > 0) {
    throw new InvalidProfileError(violations);
  }

  if (Object.keys(changes).length === 0) {
    throw new InvalidProfileError([
      { field: "_root", message: "更新する項目を1つ以上指定してください" },
    ]);
  }

  return changes;
}
