import type { ExportDataSourcePort } from "@habit-app/application";
import { DATA_EXPORT_READ_CHUNK_SIZE } from "@habit-app/domain";
import type {
  ExportAiResult,
  ExportBundle,
  ExportDailyCheckIn,
  ExportHabit,
  ExportHabitEntry,
  ExportJson,
  ExportScheduleVersion,
  ExportWeeklyReview,
} from "@habit-app/domain";
import type { PrismaClient } from "../generated/prisma/client";
import type { Tx } from "../shared/db-helpers";
import { parseUserId } from "../shared/db-helpers";

const iso = (date: Date): string => date.toISOString();
const day = (date: Date): string => date.toISOString().slice(0, 10);
const orNull = <T, R>(value: T | null, map: (v: T) => R): R | null =>
  value === null ? null : map(value);

/**
 * ExportDataSourcePort の Prisma 実装(docs/plans/data-export.md、EXP-005)。
 *
 * - 1 つの `REPEATABLE READ` の読み取り transaction で収集する。全データが同一時点の状態になる(EXP-INV-006)。
 * - 出力する項目は許可リストで列挙して SELECT する。`SELECT *` を使わない(EXP-INV-002)。
 *   パスワードのハッシュ、session、token、MFA の秘密、監査ログ、入力の指紋、内部 ID(keyset 以外)は読まない。
 * - すべての query に `user_id = job の所有者` を含める(EXP-INV-001)。
 * - 件数が多い記録・チェックインは ID 順の keyset で分割して読み込む。
 */
export function createPrismaExportDataSource(prisma: PrismaClient): ExportDataSourcePort {
  return {
    async collect({ userId: rawUserId }) {
      const userId = parseUserId(rawUserId);
      if (userId === null) throw new Error("invalid user id");
      return prisma.$transaction(async (tx) => readBundle(tx, userId), {
        isolationLevel: "RepeatableRead",
        timeout: 60_000,
      });
    },
  };
}

async function readBundle(tx: Tx, userId: bigint): Promise<ExportBundle> {
  const accounts = await tx.$queryRaw<{ email_normalized: string; created_at: Date }[]>`
    SELECT email_normalized, created_at FROM users WHERE id = ${userId}`;
  const account = accounts[0];
  if (account === undefined) throw new Error("user not found");

  const profiles = await tx.$queryRaw<
    { display_name: string | null; timezone: string; locale: string; week_starts_on: number }[]
  >`
    SELECT display_name, timezone, locale, week_starts_on
    FROM user_profiles WHERE user_id = ${userId}`;
  const profile = profiles[0];

  const habitRows = await tx.$queryRaw<
    {
      id: bigint;
      public_id: string;
      kind: string;
      name: string;
      purpose: string;
      cue: string;
      minimum_action: string;
      replacement_action: string | null;
      status: string;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT id, public_id, kind, name, purpose, cue, minimum_action, replacement_action, status,
           created_at, updated_at
    FROM habits WHERE user_id = ${userId} ORDER BY id`;

  const scheduleRows = await tx.$queryRaw<
    {
      habit_id: string;
      effective_from: Date;
      effective_to: Date | null;
      days_of_week: number[];
      target_count: number;
    }[]
  >`
    SELECT h.public_id AS habit_id, v.effective_from, v.effective_to, v.days_of_week, v.target_count
    FROM habit_schedule_versions v JOIN habits h ON h.id = v.habit_id
    WHERE h.user_id = ${userId}
    ORDER BY h.id, v.effective_from`;
  const schedulesByHabit = new Map<string, ExportScheduleVersion[]>();
  for (const row of scheduleRows) {
    const list = schedulesByHabit.get(row.habit_id) ?? [];
    list.push({
      habitId: row.habit_id,
      effectiveFrom: day(row.effective_from),
      effectiveTo: orNull(row.effective_to, day),
      daysOfWeek: row.days_of_week,
      targetCount: row.target_count,
    });
    schedulesByHabit.set(row.habit_id, list);
  }
  const habits: ExportHabit[] = habitRows.map((row) => ({
    id: row.public_id,
    kind: row.kind,
    name: row.name,
    purpose: row.purpose,
    cue: row.cue,
    minimumAction: row.minimum_action,
    replacementAction: row.replacement_action,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    scheduleVersions: schedulesByHabit.get(row.public_id) ?? [],
  }));

  const habitEntries: ExportHabitEntry[] = [];
  for (let after = 0n; ;) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        public_id: string;
        habit_id: string;
        habit_date: Date;
        status: string;
        quantity: number | null;
        note: string | null;
        source: string;
        created_at: Date;
        updated_at: Date;
      }[]
    >`
      SELECT e.id, e.public_id, h.public_id AS habit_id, e.habit_date, e.status,
             e.quantity::float8 AS quantity, e.note, e.source, e.created_at, e.updated_at
      FROM habit_entries e JOIN habits h ON h.id = e.habit_id
      WHERE e.user_id = ${userId} AND e.id > ${after}
      ORDER BY e.id LIMIT ${DATA_EXPORT_READ_CHUNK_SIZE}`;
    for (const row of rows) {
      habitEntries.push({
        id: row.public_id,
        habitId: row.habit_id,
        date: day(row.habit_date),
        status: row.status,
        quantity: row.quantity,
        note: row.note,
        source: row.source,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      });
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < DATA_EXPORT_READ_CHUNK_SIZE) break;
    after = last.id;
  }

  const dailyCheckIns: ExportDailyCheckIn[] = [];
  for (let after = 0n; ;) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        check_in_date: Date;
        mood: number | null;
        difficulty: number | null;
        note: string | null;
        created_at: Date;
        updated_at: Date;
      }[]
    >`
      SELECT id, check_in_date, mood, difficulty, note, created_at, updated_at
      FROM daily_check_ins
      WHERE user_id = ${userId} AND id > ${after}
      ORDER BY id LIMIT ${DATA_EXPORT_READ_CHUNK_SIZE}`;
    for (const row of rows) {
      dailyCheckIns.push({
        date: day(row.check_in_date),
        mood: row.mood,
        difficulty: row.difficulty,
        note: row.note,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      });
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < DATA_EXPORT_READ_CHUNK_SIZE) break;
    after = last.id;
  }

  const reviewRows = await tx.$queryRaw<
    {
      public_id: string;
      week_start: Date;
      timezone_snapshot: string;
      summary_json: ExportJson;
      reflection: string | null;
      status: string;
      completed_at: Date | null;
      created_at: Date;
    }[]
  >`
    SELECT public_id, week_start, timezone_snapshot, summary_json, reflection, status,
           completed_at, created_at
    FROM weekly_reviews WHERE user_id = ${userId} ORDER BY week_start, id`;
  const weeklyReviews: ExportWeeklyReview[] = reviewRows.map((row) => ({
    id: row.public_id,
    weekStart: day(row.week_start),
    timezoneSnapshot: row.timezone_snapshot,
    summary: row.summary_json,
    reflection: row.reflection,
    status: row.status,
    completedAt: orNull(row.completed_at, iso),
    createdAt: iso(row.created_at),
  }));

  // ユーザー単位の設定(habit_id IS NULL)のみ。time 列は SQL 側で HH:mm にする(Date 変換を介さない)。
  const settingRows = await tx.$queryRaw<
    {
      enabled: boolean;
      local_time: string;
      timezone: string;
      quiet_hours_start: string | null;
      quiet_hours_end: string | null;
    }[]
  >`
    SELECT enabled, to_char(local_time, 'HH24:MI') AS local_time, timezone,
           to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
           to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end
    FROM notification_settings WHERE user_id = ${userId} AND habit_id IS NULL`;
  const setting = settingRows[0];

  const aiRows = await tx.$queryRaw<
    {
      public_id: string;
      kind: string;
      status: string;
      prompt_version: string;
      output_schema_version: string;
      provider: string;
      model: string;
      result_json: ExportJson | null;
      failure_code: string | null;
      created_at: Date;
    }[]
  >`
    SELECT public_id, kind, status, prompt_version, output_schema_version, provider, model,
           result_json, failure_code, created_at
    FROM ai_jobs WHERE user_id = ${userId} ORDER BY id`;
  const aiResults: ExportAiResult[] = aiRows.map((row) => ({
    id: row.public_id,
    kind: row.kind,
    status: row.status,
    promptVersion: row.prompt_version,
    outputSchemaVersion: row.output_schema_version,
    provider: row.provider,
    model: row.model,
    result: row.result_json,
    failureCode: row.failure_code,
    createdAt: iso(row.created_at),
  }));

  return {
    account: { email: account.email_normalized, createdAt: iso(account.created_at) },
    profile:
      profile === undefined
        ? null
        : {
            displayName: profile.display_name,
            timezone: profile.timezone,
            locale: profile.locale,
            weekStartsOn: profile.week_starts_on,
          },
    habits,
    habitEntries,
    dailyCheckIns,
    weeklyReviews,
    notificationSettings:
      setting === undefined
        ? null
        : {
            enabled: setting.enabled,
            localTime: setting.local_time,
            timezone: setting.timezone,
            quietHours:
              setting.quiet_hours_start === null || setting.quiet_hours_end === null
                ? null
                : { start: setting.quiet_hours_start, end: setting.quiet_hours_end },
          },
    aiResults,
  };
}
