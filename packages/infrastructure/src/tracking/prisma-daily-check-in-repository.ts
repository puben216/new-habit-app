import type { DailyCheckInRecord, DailyCheckInRepositoryPort } from "@habit-app/application";
import type { PrismaClient } from "../generated/prisma/client";

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** actor の user ID(session 由来の十進文字列)を bigint へ。形式不正は「何にも到達できない」扱い。 */
function parseUserId(actorUserId: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(actorUserId)) return null;
  const value = BigInt(actorUserId);
  return value <= MAX_BIGINT ? value : null;
}

function dateFromCalendarDate(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

function calendarDateFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(): Error {
  return new Error("persisted daily check-in violates invariants");
}

function toScale(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 5) throw corrupted();
  return value;
}

interface UpsertRow {
  check_in_date: Date;
  mood: number | null;
  difficulty: number | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: {
  date: Date;
  mood: number | null;
  difficulty: number | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DailyCheckInRecord {
  return {
    date: calendarDateFromDate(row.date),
    mood: toScale(row.mood),
    difficulty: toScale(row.difficulty),
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * DailyCheckInRepositoryPort の Prisma 実装(docs/plans/daily-check-in.md)。
 *
 * - すべての query が `user_id = actor` を条件に含む(DCI-INV-001)。
 * - upsert は `INSERT ... ON CONFLICT (user_id, check_in_date) DO UPDATE` の単一文(DCI-INV-002)。
 *   並行実行でも一意制約違反にならず、後勝ちで 1 レコードに収束する。actor の user が存在しない
 *   場合は FK 違反ではなく、INSERT ... SELECT が 0 行になり `null` を返す。
 * - raw SQL は `$queryRaw` のタグ付きテンプレート(バインド変数のみ)で、文字列連結をしない。
 * - created_at は新規作成時のみ呼び出し側 Clock の値。更新時の updated_at は DB の
 *   `set_updated_at` trigger(CURRENT_TIMESTAMP)が決める(docs/04-database-design.md)。
 */
export function createPrismaDailyCheckInRepository(
  prisma: PrismaClient,
): DailyCheckInRepositoryPort {
  return {
    async find({ actorUserId, date }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !CALENDAR_DATE_PATTERN.test(date)) return null;

      const row = await prisma.dailyCheckIn.findFirst({
        where: { userId, checkInDate: dateFromCalendarDate(date) },
      });
      return row === null ? null : toRecord({ ...row, date: row.checkInDate });
    },

    async listByDateRange({ actorUserId, from, to }) {
      const userId = parseUserId(actorUserId);
      if (userId === null) return [];
      if (!CALENDAR_DATE_PATTERN.test(from) || !CALENDAR_DATE_PATTERN.test(to)) return [];

      const rows = await prisma.dailyCheckIn.findMany({
        where: {
          userId,
          checkInDate: { gte: dateFromCalendarDate(from), lte: dateFromCalendarDate(to) },
        },
        orderBy: { checkInDate: "asc" },
      });
      return rows.map((row) => toRecord({ ...row, date: row.checkInDate }));
    },

    async upsert({ actorUserId, date, mood, difficulty, note, now }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !CALENDAR_DATE_PATTERN.test(date)) return null;

      const rows = await prisma.$queryRaw<UpsertRow[]>`
        INSERT INTO daily_check_ins
          (user_id, check_in_date, mood, difficulty, note, created_at, updated_at)
        SELECT u.id, ${dateFromCalendarDate(date)}::date, ${mood}::smallint,
               ${difficulty}::smallint, ${note}, ${now}, ${now}
        FROM users u
        WHERE u.id = ${userId}
        ON CONFLICT (user_id, check_in_date) DO UPDATE
          SET mood = EXCLUDED.mood,
              difficulty = EXCLUDED.difficulty,
              note = EXCLUDED.note,
              updated_at = EXCLUDED.updated_at
        RETURNING check_in_date, mood, difficulty, note, created_at, updated_at`;

      const row = rows[0];
      if (row === undefined) return null;
      return toRecord({
        date: row.check_in_date,
        mood: row.mood,
        difficulty: row.difficulty,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    },
  };
}
