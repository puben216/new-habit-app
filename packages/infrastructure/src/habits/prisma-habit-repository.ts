import { HabitDomainError, reconstituteHabit } from "@habit-app/domain";
import type { Habit, ScheduleVersion } from "@habit-app/domain";
import type {
  HabitRecord,
  HabitRepositoryPort,
  ListHabitsRepositoryResult,
  SaveHabitResult,
} from "@habit-app/application";
import type { Prisma, PrismaClient } from "../generated/prisma/client";

const habitInclude = {
  scheduleVersions: { orderBy: { effectiveFrom: "asc" } },
} as const satisfies Prisma.HabitInclude;

type HabitRow = Prisma.HabitGetPayload<{ include: typeof habitInclude }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/**
 * actor の user ID(session 由来の十進文字列)を DB の bigint に変換する。
 * 形式不正は「どの習慣にも到達できない」扱いにするため null を返す(例外にしない)。
 */
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

function scheduleData(version: ScheduleVersion) {
  return {
    effectiveFrom: dateFromCalendarDate(version.effectiveFrom),
    effectiveTo: version.effectiveTo === null ? null : dateFromCalendarDate(version.effectiveTo),
    daysOfWeek: [...version.daysOfWeek],
    targetCount: version.targetCount,
  };
}

function toRecord(row: HabitRow): HabitRecord {
  let habit: Habit;
  try {
    habit = reconstituteHabit({
      id: row.publicId,
      kind: row.kind,
      status: row.status,
      name: row.name,
      purpose: row.purpose,
      cue: row.cue,
      minimumAction: row.minimumAction,
      replacementAction: row.replacementAction,
      scheduleVersions: row.scheduleVersions.map((version) => ({
        effectiveFrom: calendarDateFromDate(version.effectiveFrom),
        effectiveTo:
          version.effectiveTo === null ? null : calendarDateFromDate(version.effectiveTo),
        daysOfWeek: version.daysOfWeek,
        targetCount: version.targetCount,
      })),
    });
  } catch (error) {
    if (error instanceof HabitDomainError) {
      // 保存データの破損。自由記述を含みうる Domain のメッセージは伝播させない。
      throw new Error(`persisted habit violates domain invariants (${error.name})`);
    }
    throw error;
  }
  return { habit, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * HabitRepositoryPort の Prisma 実装(docs/plans/habit-api.md)。
 *
 * - すべての query が `user_id = actor` を条件に含む(HAPI-INV-001)。
 * - save は 1 transaction 内で、habit 行の条件付き更新(`WHERE id AND user_id AND version`)と
 *   ScheduleVersion の差分反映を行う(HAPI-INV-002)。READ COMMITTED でも、同一行への条件付き
 *   UPDATE は行ロックの解放後に条件を再評価するため、並行更新は片方だけが成功する。
 * - ScheduleVersion の反映は「既存行の effectiveTo 更新 → 新規行の insert」の順で行い、
 *   有効期間の exclusion constraint を一時的にも破らない。
 * - created_at は呼び出し側 Clock のミリ秒精度で書き込む。Prisma の Date と DB の
 *   マイクロ秒精度の差で keyset(created_at, id) の比較がずれるのを避けるため(HAPI-INV-004)。
 */
export function createPrismaHabitRepository(prisma: PrismaClient): HabitRepositoryPort {
  return {
    async create({ actorUserId, habit, now }) {
      const userId = parseUserId(actorUserId);
      if (userId === null) throw new Error("invalid actor user id");

      const row = await prisma.habit.create({
        data: {
          publicId: habit.id,
          userId,
          kind: habit.kind,
          name: habit.name,
          purpose: habit.purpose,
          cue: habit.cue,
          minimumAction: habit.minimumAction,
          replacementAction: habit.replacementAction,
          status: habit.status,
          version: 1,
          createdAt: now,
          updatedAt: now,
          scheduleVersions: { create: habit.scheduleVersions.map(scheduleData) },
        },
        include: habitInclude,
      });
      return toRecord(row);
    },

    async findById({ actorUserId, habitId }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !UUID_PATTERN.test(habitId)) return null;

      const row = await prisma.habit.findFirst({
        where: { publicId: habitId, userId },
        include: habitInclude,
      });
      return row === null ? null : toRecord(row);
    },

    async list({ actorUserId, status, limit, afterHabitId }): Promise<ListHabitsRepositoryResult> {
      const userId = parseUserId(actorUserId);
      if (userId === null) {
        return afterHabitId === null
          ? { ok: true, items: [] }
          : { ok: false, reason: "cursor_not_found" };
      }

      let keyset: Prisma.HabitWhereInput = {};
      if (afterHabitId !== null) {
        // keyset の位置は (created_at, id) のみで決まる。status は条件に含めない
        // (ページ送りの途中で archive された習慣を指す cursor を無効にしないため)。
        const position = UUID_PATTERN.test(afterHabitId)
          ? await prisma.habit.findFirst({
              where: { publicId: afterHabitId, userId },
              select: { id: true, createdAt: true },
            })
          : null;
        if (position === null) return { ok: false, reason: "cursor_not_found" };
        keyset = {
          OR: [
            { createdAt: { lt: position.createdAt } },
            { createdAt: position.createdAt, id: { lt: position.id } },
          ],
        };
      }

      const rows = await prisma.habit.findMany({
        where: { userId, status, ...keyset },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        include: habitInclude,
      });
      return { ok: true, items: rows.map(toRecord) };
    },

    async save({ actorUserId, habit, expectedVersion, now }): Promise<SaveHabitResult> {
      const userId = parseUserId(actorUserId);
      if (userId === null || !UUID_PATTERN.test(habit.id)) return { status: "not_found" };

      return prisma.$transaction(async (tx): Promise<SaveHabitResult> => {
        const current = await tx.habit.findFirst({
          where: { publicId: habit.id, userId },
          select: { id: true, version: true },
        });
        if (current === null) return { status: "not_found" };
        if (current.version !== expectedVersion) return { status: "conflict" };

        const updated = await tx.habit.updateMany({
          where: { id: current.id, userId, version: expectedVersion },
          data: {
            name: habit.name,
            purpose: habit.purpose,
            cue: habit.cue,
            minimumAction: habit.minimumAction,
            replacementAction: habit.replacementAction,
            status: habit.status,
            version: { increment: 1 },
            updatedAt: now,
          },
        });
        if (updated.count !== 1) return { status: "conflict" };

        const existing = await tx.habitScheduleVersion.findMany({ where: { habitId: current.id } });
        const existingByFrom = new Map(
          existing.map((row) => [calendarDateFromDate(row.effectiveFrom), row]),
        );
        const toCreate: ScheduleVersion[] = [];
        for (const version of habit.scheduleVersions) {
          const row = existingByFrom.get(version.effectiveFrom);
          if (row === undefined) {
            toCreate.push(version);
            continue;
          }
          const data = scheduleData(version);
          const unchanged =
            (row.effectiveTo === null
              ? data.effectiveTo === null
              : data.effectiveTo !== null &&
                row.effectiveTo.getTime() === data.effectiveTo.getTime()) &&
            row.targetCount === data.targetCount &&
            row.daysOfWeek.length === data.daysOfWeek.length &&
            row.daysOfWeek.every((day, index) => day === data.daysOfWeek[index]);
          if (!unchanged) {
            await tx.habitScheduleVersion.update({
              where: { id: row.id },
              data: {
                effectiveTo: data.effectiveTo,
                daysOfWeek: data.daysOfWeek,
                targetCount: data.targetCount,
              },
            });
          }
        }
        if (toCreate.length > 0) {
          await tx.habitScheduleVersion.createMany({
            data: toCreate.map((version) => ({ habitId: current.id, ...scheduleData(version) })),
          });
        }

        const fresh = await tx.habit.findUniqueOrThrow({
          where: { id: current.id },
          include: habitInclude,
        });
        return { status: "saved", record: toRecord(fresh) };
      });
    },
  };
}
