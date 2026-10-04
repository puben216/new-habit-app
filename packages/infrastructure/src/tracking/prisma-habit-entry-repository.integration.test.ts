import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HabitNotFoundError,
  createHabitUseCase,
  getTodayScheduleUseCase,
  upsertHabitEntryUseCase,
} from "@habit-app/application";
import type { CreateHabitUseCaseInput } from "@habit-app/application";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createPrismaHabitRepository } from "../habits/prisma-habit-repository";
import { createUuidGenerator } from "../habits/uuid-generator";
import { createPrismaProfileRepository } from "../identity/prisma-profile-repository";
import { createPrismaHabitEntryRepository } from "./prisma-habit-entry-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");

// 2026-01-14(水)12:00 JST。
const NOW = new Date("2026-01-14T03:00:00.000Z");
const TODAY = "2026-01-14";

describe("PrismaHabitEntryRepository(T-202)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let userA: string;
  let userB: string;

  const clock = () => NOW;
  const habitRepository = () => createPrismaHabitRepository(prisma);
  const entryRepository = () => createPrismaHabitEntryRepository(prisma);
  const profileRepository = () => createPrismaProfileRepository(prisma);
  const upsertDeps = () => ({
    habitRepository: habitRepository(),
    entryRepository: entryRepository(),
    profileRepository: profileRepository(),
    now: clock,
  });

  async function createUser(label: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}@example.com`,
        emailNormalized: `${label}@example.com`,
        passwordHash: "hash",
      },
    });
    return user.id.toString();
  }

  async function createHabit(
    actorUserId: string,
    overrides: Partial<CreateHabitUseCaseInput> = {},
  ): Promise<string> {
    const record = await createHabitUseCase(
      { habitRepository: habitRepository(), idGenerator: createUuidGenerator(), now: clock },
      {
        actorUserId,
        kind: "build",
        name: "水を飲む",
        purpose: "健康維持",
        cue: "起床直後",
        minimumAction: "コップ1杯",
        schedule: {
          effectiveFrom: "2025-01-01",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          targetCount: 3,
        },
        ...overrides,
      },
    );
    return record.habit.id;
  }

  async function countEntries(): Promise<number> {
    return prisma.habitEntry.count();
  }

  beforeAll(async () => {
    container = await startPostgresContainer();
    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });
    prisma = createPrismaClient(container.getConnectionUri());
    userA = await createUser("entry-user-a");
    userB = await createUser("entry-user-b");
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  describe("upsert(HENT-002)", () => {
    it("作成→訂正で同じレコードが上書きされ、各 status が往復できる", async () => {
      const habitId = await createHabit(userA);
      const base = { actorUserId: userA, habitId, date: TODAY };

      const missed = await upsertHabitEntryUseCase(upsertDeps(), {
        ...base,
        status: "missed",
        quantity: 2,
      });
      expect(missed).toMatchObject({ habitId, date: TODAY, status: "missed", quantity: 2 });
      expect(missed.createdAt).toEqual(NOW);

      const success = await upsertHabitEntryUseCase(upsertDeps(), { ...base, status: "success" });
      expect(success).toMatchObject({ status: "success", quantity: 3 });
      expect(success.createdAt).toEqual(missed.createdAt);

      const skipped = await upsertHabitEntryUseCase(upsertDeps(), { ...base, status: "skipped" });
      expect(skipped).toMatchObject({ status: "skipped", quantity: null });

      expect(await prisma.habitEntry.count({ where: { habit: { publicId: habitId } } })).toBe(1);
    });

    it("同一内容の再送は同じ結果で、レコードは増えない", async () => {
      const habitId = await createHabit(userA);
      const input = { actorUserId: userA, habitId, date: TODAY, status: "success" as const };
      const first = await upsertHabitEntryUseCase(upsertDeps(), input);
      const second = await upsertHabitEntryUseCase(upsertDeps(), input);
      // 更新時の updated_at は DB の set_updated_at trigger(CURRENT_TIMESTAMP)が決める。
      expect({ ...second, updatedAt: undefined }).toEqual({ ...first, updatedAt: undefined });
      expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
      expect(await prisma.habitEntry.count({ where: { habit: { publicId: habitId } } })).toBe(1);
    });

    it("同じ (habit, date) への並行 upsert はすべて成功し 1 レコードに収束する", async () => {
      const habitId = await createHabit(userA);
      const statuses = ["success", "missed", "skipped", "success", "missed", "skipped"] as const;
      const results = await Promise.allSettled(
        statuses.map((status) =>
          upsertHabitEntryUseCase(upsertDeps(), {
            actorUserId: userA,
            habitId,
            date: TODAY,
            status,
          }),
        ),
      );
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(await prisma.habitEntry.count({ where: { habit: { publicId: habitId } } })).toBe(1);
    });

    it("日付が異なれば別レコードになる", async () => {
      const habitId = await createHabit(userA);
      for (const date of ["2026-01-12", "2026-01-13", TODAY]) {
        await upsertHabitEntryUseCase(upsertDeps(), {
          actorUserId: userA,
          habitId,
          date,
          status: "success",
        });
      }
      expect(await prisma.habitEntry.count({ where: { habit: { publicId: habitId } } })).toBe(3);
    });

    it("source は web、note と scheduled_for は NULL", async () => {
      const habitId = await createHabit(userA);
      await upsertHabitEntryUseCase(upsertDeps(), {
        actorUserId: userA,
        habitId,
        date: TODAY,
        status: "success",
      });
      const row = await prisma.habitEntry.findFirstOrThrow({
        where: { habit: { publicId: habitId } },
      });
      expect(row.source).toBe("web");
      expect(row.note).toBeNull();
      expect(row.scheduledFor).toBeNull();
    });
  });

  describe("所有者限定(HENT-INV-001)", () => {
    it("他ユーザーの習慣への upsert は NotFound で何も書かれない", async () => {
      const habitId = await createHabit(userA);
      const before = await countEntries();
      await expect(
        upsertHabitEntryUseCase(upsertDeps(), {
          actorUserId: userB,
          habitId,
          date: TODAY,
          status: "success",
        }),
      ).rejects.toBeInstanceOf(HabitNotFoundError);
      expect(await countEntries()).toBe(before);
    });

    it("repository 直呼びでも他ユーザーの習慣・形式不正な値には書けない", async () => {
      const habitId = await createHabit(userA);
      const repo = entryRepository();
      const base = { date: TODAY, status: "success" as const, quantity: 3, now: NOW };
      expect(await repo.upsert({ ...base, actorUserId: userB, habitId })).toBeNull();
      expect(await repo.upsert({ ...base, actorUserId: "not-a-number", habitId })).toBeNull();
      expect(await repo.upsert({ ...base, actorUserId: userA, habitId: "not-a-uuid" })).toBeNull();
      expect(
        await repo.upsert({ ...base, actorUserId: userA, habitId, date: "2026-1-1" }),
      ).toBeNull();
    });

    it("listByDate は他ユーザーの記録を返さない", async () => {
      const habitA = await createHabit(userA);
      const habitB = await createHabit(userB);
      await upsertHabitEntryUseCase(upsertDeps(), {
        actorUserId: userA,
        habitId: habitA,
        date: "2026-01-10",
        status: "success",
      });
      await upsertHabitEntryUseCase(upsertDeps(), {
        actorUserId: userB,
        habitId: habitB,
        date: "2026-01-10",
        status: "missed",
      });
      const forA = await entryRepository().listByDate({ actorUserId: userA, date: "2026-01-10" });
      expect(forA.map((e) => e.habitId)).toEqual([habitA]);
      const forB = await entryRepository().listByDate({ actorUserId: userB, date: "2026-01-10" });
      expect(forB.map((e) => e.habitId)).toEqual([habitB]);
    });
  });

  describe("今日の予定(HENT-001)", () => {
    it("予定された習慣と今日の記録を返す。他ユーザーの習慣は含まれない", async () => {
      const own = await createUser("entry-today-own");
      const other = await createUser("entry-today-other");
      const habit = await createHabit(own, { name: "own-1" });
      await createHabit(own, {
        name: "monday-only",
        schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [1], targetCount: 1 },
      });
      await createHabit(other, { name: "other-1" });

      await upsertHabitEntryUseCase(upsertDeps(), {
        actorUserId: own,
        habitId: habit,
        date: TODAY,
        status: "missed",
        quantity: 1,
      });

      const today = await getTodayScheduleUseCase(upsertDeps(), { actorUserId: own });
      expect(today.date).toBe(TODAY);
      expect(today.timezone).toBe("Asia/Tokyo");
      expect(today.items.map((i) => i.habit.name)).toEqual(["own-1"]);
      expect(today.items[0]?.entry).toMatchObject({ status: "missed", quantity: 1 });
    });
  });

  describe("DB 制約(Migration)", () => {
    async function insertRaw(quantity: number): Promise<void> {
      const habitId = await createHabit(userA);
      const habit = await prisma.habit.findFirstOrThrow({ where: { publicId: habitId } });
      await prisma.$executeRaw`
        INSERT INTO habit_entries (user_id, habit_id, habit_date, status, quantity)
        VALUES (${habit.userId}, ${habit.id}, '2026-01-01'::date, 'success', ${quantity}::numeric)`;
    }

    it("quantity の負数と 1001 は CHECK 制約で拒否され、0 と 1000 は受理される", async () => {
      await expect(insertRaw(-1)).rejects.toThrow();
      await expect(insertRaw(1001)).rejects.toThrow();
      await expect(insertRaw(0)).resolves.toBeUndefined();
      await expect(insertRaw(1000)).resolves.toBeUndefined();
    });

    it("制約 habit_entries_quantity_check が存在する", async () => {
      const rows = await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint WHERE conname = 'habit_entries_quantity_check'`;
      expect(rows).toHaveLength(1);
    });
  });
});
