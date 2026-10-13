/**
 * エクスポートする「自分のデータ」の型と、出力する項目の許可リスト(docs/specs/data-export.md
 * 「出力するデータ」、EXP-INV-002)。公開 ID(UUID)で互いを参照し、内部 ID(bigint)は持たない。
 * 日時は ISO 8601(UTC)、日付は `YYYY-MM-DD` の文字列で、データ収集の側で変換して渡す。
 */

export type ExportJson =
  string | number | boolean | null | readonly ExportJson[] | { readonly [key: string]: ExportJson };

export interface ExportAccount {
  readonly email: string;
  readonly createdAt: string;
}

export interface ExportProfile {
  readonly displayName: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly weekStartsOn: number;
}

export interface ExportScheduleVersion {
  readonly habitId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly daysOfWeek: readonly number[];
  readonly targetCount: number;
}

export interface ExportHabitBase {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly purpose: string;
  readonly cue: string;
  readonly minimumAction: string;
  readonly replacementAction: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExportHabit extends ExportHabitBase {
  readonly scheduleVersions: readonly ExportScheduleVersion[];
}

export interface ExportHabitEntry {
  readonly id: string;
  readonly habitId: string;
  readonly date: string;
  readonly status: string;
  readonly quantity: number | null;
  readonly note: string | null;
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExportDailyCheckIn {
  readonly date: string;
  readonly mood: number | null;
  readonly difficulty: number | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExportWeeklyReview {
  readonly id: string;
  readonly weekStart: string;
  readonly timezoneSnapshot: string;
  readonly summary: ExportJson;
  readonly reflection: string | null;
  readonly status: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export interface ExportNotificationSettings {
  readonly enabled: boolean;
  readonly localTime: string;
  readonly timezone: string;
  readonly quietHours: { readonly start: string; readonly end: string } | null;
}

export interface ExportAiResult {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly result: ExportJson | null;
  readonly failureCode: string | null;
  readonly createdAt: string;
}

export interface ExportBundle {
  readonly account: ExportAccount;
  readonly profile: ExportProfile | null;
  readonly habits: readonly ExportHabit[];
  readonly habitEntries: readonly ExportHabitEntry[];
  readonly dailyCheckIns: readonly ExportDailyCheckIn[];
  readonly weeklyReviews: readonly ExportWeeklyReview[];
  readonly notificationSettings: ExportNotificationSettings | null;
  readonly aiResults: readonly ExportAiResult[];
}

/** 型の項目をすべて列挙した許可リストであることを、コンパイル時に検査する(項目の追加の取りこぼしを防ぐ)。 */
type ExhaustiveFields<T, K extends keyof T> = [Exclude<keyof T, K>] extends [never] ? K : never;

function fields<T>() {
  return <const K extends readonly (keyof T)[]>(
    list: K & readonly ExhaustiveFields<T, K[number]>[],
  ) => list as readonly (keyof T & string)[];
}

export const ACCOUNT_FIELDS = fields<ExportAccount>()(["email", "createdAt"]);
export const PROFILE_FIELDS = fields<ExportProfile>()([
  "displayName",
  "timezone",
  "locale",
  "weekStartsOn",
]);
export const HABIT_FIELDS = fields<ExportHabitBase>()([
  "id",
  "kind",
  "name",
  "purpose",
  "cue",
  "minimumAction",
  "replacementAction",
  "status",
  "createdAt",
  "updatedAt",
]);
export const SCHEDULE_VERSION_FIELDS = fields<ExportScheduleVersion>()([
  "habitId",
  "effectiveFrom",
  "effectiveTo",
  "daysOfWeek",
  "targetCount",
]);
export const HABIT_ENTRY_FIELDS = fields<ExportHabitEntry>()([
  "id",
  "habitId",
  "date",
  "status",
  "quantity",
  "note",
  "source",
  "createdAt",
  "updatedAt",
]);
export const DAILY_CHECK_IN_FIELDS = fields<ExportDailyCheckIn>()([
  "date",
  "mood",
  "difficulty",
  "note",
  "createdAt",
  "updatedAt",
]);
export const WEEKLY_REVIEW_FIELDS = fields<ExportWeeklyReview>()([
  "id",
  "weekStart",
  "timezoneSnapshot",
  "summary",
  "reflection",
  "status",
  "completedAt",
  "createdAt",
]);
export const NOTIFICATION_SETTINGS_FIELDS = fields<ExportNotificationSettings>()([
  "enabled",
  "localTime",
  "timezone",
  "quietHours",
]);
export const AI_RESULT_FIELDS = fields<ExportAiResult>()([
  "id",
  "kind",
  "status",
  "promptVersion",
  "outputSchemaVersion",
  "provider",
  "model",
  "result",
  "failureCode",
  "createdAt",
]);

/** 許可リストの項目だけを取り出す。型に無い余計な項目(収集側の取りこぼし)は出力されない。 */
export function pickFields<T extends object>(
  source: T,
  list: readonly (keyof T & string)[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of list) picked[key] = source[key] ?? null;
  return picked;
}
