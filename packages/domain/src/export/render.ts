import type { ExportBundle } from "./bundle";
import {
  ACCOUNT_FIELDS,
  AI_RESULT_FIELDS,
  DAILY_CHECK_IN_FIELDS,
  HABIT_ENTRY_FIELDS,
  HABIT_FIELDS,
  NOTIFICATION_SETTINGS_FIELDS,
  PROFILE_FIELDS,
  SCHEDULE_VERSION_FIELDS,
  WEEKLY_REVIEW_FIELDS,
  pickFields,
} from "./bundle";
import { toCsv } from "./csv";
import { encodeUtf8 } from "./utf8";
import type { CsvValue } from "./csv";
import { buildStoredZip } from "./zip";

/**
 * エクスポートの出力の組み立て(docs/specs/data-export.md EXP-006)。
 * どちらの形式も、`bundle.ts` の許可リストの項目だけを出力する(EXP-INV-002)。
 */

/** JSON の構造の版。項目の追加・削除・名前の変更をするときに上げる。 */
export const EXPORT_SCHEMA_VERSION = 1;

/** JSON(1 ファイル)。UTF-8、インデント 2。 */
export function buildExportJson(bundle: ExportBundle, exportedAt: Date): Uint8Array {
  const document = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    account: pickFields(bundle.account, ACCOUNT_FIELDS),
    profile: bundle.profile === null ? null : pickFields(bundle.profile, PROFILE_FIELDS),
    habits: bundle.habits.map((habit) => ({
      ...pickFields(habit, HABIT_FIELDS),
      scheduleVersions: habit.scheduleVersions.map((version) =>
        pickFields(version, SCHEDULE_VERSION_FIELDS),
      ),
    })),
    habitEntries: bundle.habitEntries.map((entry) => pickFields(entry, HABIT_ENTRY_FIELDS)),
    dailyCheckIns: bundle.dailyCheckIns.map((checkIn) =>
      pickFields(checkIn, DAILY_CHECK_IN_FIELDS),
    ),
    weeklyReviews: bundle.weeklyReviews.map((review) => pickFields(review, WEEKLY_REVIEW_FIELDS)),
    notificationSettings:
      bundle.notificationSettings === null
        ? null
        : pickFields(bundle.notificationSettings, NOTIFICATION_SETTINGS_FIELDS),
    aiResults: bundle.aiResults.map((result) => pickFields(result, AI_RESULT_FIELDS)),
  };
  return encodeUtf8(JSON.stringify(document, null, 2) + "\n");
}

/** CSV の各ファイルの先頭に付ける BOM(Excel が UTF-8 と判定できるようにする)。 */
const BOM = "﻿";

function csvFile(columns: readonly string[], rows: readonly (readonly CsvValue[])[]): Uint8Array {
  return encodeUtf8(BOM + toCsv(columns, rows));
}

function rowOf(source: object, columns: readonly string[]): CsvValue[] {
  const record = source as Record<string, CsvValue>;
  return columns.map((column) => record[column] ?? null);
}

const NOTIFICATION_CSV_COLUMNS = [
  "enabled",
  "localTime",
  "timezone",
  "quietHoursStart",
  "quietHoursEnd",
] as const;

/** CSV の ZIP に含めるファイル名の一覧(README.txt と Spec の表で使う)。 */
export const EXPORT_CSV_FILE_NAMES = [
  "account.csv",
  "profile.csv",
  "habits.csv",
  "habit_schedule_versions.csv",
  "habit_entries.csv",
  "daily_check_ins.csv",
  "weekly_reviews.csv",
  "notification_settings.csv",
  "ai_results.csv",
  "README.txt",
] as const;

function readme(exportedAt: Date): string {
  return [
    "Habit App データエクスポート / Data export",
    "",
    `exportedAt: ${exportedAt.toISOString()}`,
    `schemaVersion: ${EXPORT_SCHEMA_VERSION}`,
    "",
    "各 CSV は UTF-8(BOM 付き)、改行は CRLF、1 行目は項目名です。",
    "Each CSV is UTF-8 with a BOM, CRLF line endings, and a header row.",
    "",
    "- account.csv: アカウント(email、createdAt)",
    "- profile.csv: プロフィール",
    "- habits.csv: 習慣(id は公開 ID)",
    "- habit_schedule_versions.csv: 習慣のスケジュール(habitId で habits.csv と対応)",
    "- habit_entries.csv: 習慣の記録(habitId で habits.csv と対応)",
    "- daily_check_ins.csv: デイリーチェックイン",
    "- weekly_reviews.csv: 週次レビュー(summary は JSON 文字列)",
    "- notification_settings.csv: 通知設定(quietHoursStart/End は quiet hours がなければ空)",
    "- ai_results.csv: AI の結果(result は JSON 文字列)",
    "",
    "daysOfWeek は 0(日曜)〜6(土曜)の JSON 配列です。",
    "日時は ISO 8601(UTC)、日付は YYYY-MM-DD です。",
    "表計算ソフトが数式として実行しないよう、=、+、-、@ で始まる文字列の先頭には ' を付けています。",
    "To prevent spreadsheet formula execution, text cells starting with =, +, -, or @ are prefixed with '.",
    "",
  ].join("\r\n");
}

/** CSV(データ種別ごとのファイルを 1 つの ZIP にまとめる)。 */
export function buildExportCsvZip(bundle: ExportBundle, exportedAt: Date): Uint8Array {
  const settings = bundle.notificationSettings;
  const entries = [
    {
      name: "account.csv",
      data: csvFile(ACCOUNT_FIELDS, [rowOf(bundle.account, ACCOUNT_FIELDS)]),
    },
    {
      name: "profile.csv",
      data: csvFile(
        PROFILE_FIELDS,
        bundle.profile === null ? [] : [rowOf(bundle.profile, PROFILE_FIELDS)],
      ),
    },
    {
      name: "habits.csv",
      data: csvFile(
        HABIT_FIELDS,
        bundle.habits.map((habit) => rowOf(habit, HABIT_FIELDS)),
      ),
    },
    {
      name: "habit_schedule_versions.csv",
      data: csvFile(
        SCHEDULE_VERSION_FIELDS,
        bundle.habits.flatMap((habit) =>
          habit.scheduleVersions.map((version) => rowOf(version, SCHEDULE_VERSION_FIELDS)),
        ),
      ),
    },
    {
      name: "habit_entries.csv",
      data: csvFile(
        HABIT_ENTRY_FIELDS,
        bundle.habitEntries.map((entry) => rowOf(entry, HABIT_ENTRY_FIELDS)),
      ),
    },
    {
      name: "daily_check_ins.csv",
      data: csvFile(
        DAILY_CHECK_IN_FIELDS,
        bundle.dailyCheckIns.map((checkIn) => rowOf(checkIn, DAILY_CHECK_IN_FIELDS)),
      ),
    },
    {
      name: "weekly_reviews.csv",
      data: csvFile(
        WEEKLY_REVIEW_FIELDS,
        bundle.weeklyReviews.map((review) => rowOf(review, WEEKLY_REVIEW_FIELDS)),
      ),
    },
    {
      name: "notification_settings.csv",
      data: csvFile(
        NOTIFICATION_CSV_COLUMNS,
        settings === null
          ? []
          : [
              [
                settings.enabled,
                settings.localTime,
                settings.timezone,
                settings.quietHours?.start ?? null,
                settings.quietHours?.end ?? null,
              ],
            ],
      ),
    },
    {
      name: "ai_results.csv",
      data: csvFile(
        AI_RESULT_FIELDS,
        bundle.aiResults.map((result) => rowOf(result, AI_RESULT_FIELDS)),
      ),
    },
    { name: "README.txt", data: encodeUtf8(readme(exportedAt)) },
  ];
  return buildStoredZip(entries, exportedAt);
}
