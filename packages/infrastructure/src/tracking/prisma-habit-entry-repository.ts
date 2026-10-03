import { HABIT_ENTRY_STATUSES } from "@habit-app/domain";
import type { HabitEntryStatus } from "@habit-app/domain";
import type { HabitEntryRecord, HabitEntryRepositoryPort } from "@habit-app/application";
import type { PrismaClient } from "../generated/prisma/client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** actor の user ID(session 由来の十進文字列)を bigint へ。形式不正は「何にも到達できない」扱い。 */
function parseUserId(actorUserId: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(actorUserId)) return null;
  const value = BigInt(actorUserId);
  return value <= MAX_BIGINT ? value : null;
}

function isStatus(value: string): value is HabitEntryStatus {
  return (HABIT_ENTRY_STATUSES as readonly string[]).includes(value);
}

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(): Error {
  return new Error("persisted habit entry violates invariants");
}

function toStatus(value: string): HabitEntryStatus {
  if (!isStatus(value)) throw corrupted();
  return value;
}

/** numeric(Prisma.Decimal など toString 可能な値)を、整数であることを確認して number へ。 */
function toQuantity(value: { toString(): string } | null): number | null {
  if (value === null) return null;
  const quantity = Number(value.toString());
  if (!Number.isInteger(quantity)) throw corrupted();
  return quantity;
}

function dateFromCalendarDate(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

function calendarDateFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface UpsertRow {
  habit_date: Date;
  status: string;
  quantity: { toString(): string } | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * HabitEntryRepositoryPort の Prisma 実装(docs/plans/habit-entry.md)。
 *
 * - すべての query が `user_id = actor` を条件に含む(HENT-INV-001)。upsert は習慣を
 *   `public_id` と `user_id` の両方で解決するため、他ユーザーの習慣へは書き込めない。
 * - upsert は `INSERT ... ON CONFLICT (habit_id, habit_date) DO UPDATE` の単一文(HENT-INV-002)。
 *   並行実行でも一意制約違反にならず、後勝ちで 1 レコードに収束する。
 * - raw SQL は `$queryRaw` のタグ付きテンプレート(バインド変数のみ)で、文字列連結をしない。
 * - created_at は呼び出し側 Clock の値を書き込む。updated_at は新規作成時のみ Clock の値で、更新時は
 *   DB の `set_updated_at` trigger(CURRENT_TIMESTAMP)が上書きする(docs/04-database-design.md)。
 */
export function createPrismaHabitEntryRepository(prisma: PrismaClient): HabitEntryRepositoryPort {
  return {
    async upsert({ actorUserId, habitId, date, status, quantity, now }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !UUID_PATTERN.test(habitId) || !CALENDAR_DATE_PATTERN.test(date)) {
        return null;
      }

      const rows = await prisma.$queryRaw<UpsertRow[]>`
        INSERT INTO habit_entries
          (user_id, habit_id, habit_date, status, quantity, source, created_at, updated_at)
        SELECT h.user_id, h.id, ${dateFromCalendarDate(date)}::date, ${status},
               ${quantity}::numeric, 'web', ${now}, ${now}
        FROM habits h
        WHERE h.public_id = ${habitId}::uuid AND h.user_id = ${userId}
        ON CONFLICT (habit_id, habit_date) DO UPDATE
          SET status = EXCLUDED.status,
              quantity = EXCLUDED.quantity,
              updated_at = EXCLUDED.updated_at
        RETURNING habit_date, status, quantity, created_at, updated_at`;

      const row = rows[0];
      if (row === undefined) return null;
      return {
        habitId,
        date: calendarDateFromDate(row.habit_date),
        status: toStatus(row.status),
        quantity: toQuantity(row.quantity),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies HabitEntryRecord;
    },

    async listByDate({ actorUserId, date }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !CALENDAR_DATE_PATTERN.test(date)) return [];

      const rows = await prisma.habitEntry.findMany({
        where: { userId, habitDate: dateFromCalendarDate(date) },
        include: { habit: { select: { publicId: true } } },
        orderBy: { id: "asc" },
      });
      return rows.map((row): HabitEntryRecord => ({
        habitId: row.habit.publicId,
        date: calendarDateFromDate(row.habitDate),
        status: toStatus(row.status),
        quantity: toQuantity(row.quantity),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },
  };
}
