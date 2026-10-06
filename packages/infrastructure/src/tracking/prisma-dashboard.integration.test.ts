import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  archiveHabitUseCase,
  createHabitUseCase,
  getDashboardUseCase,
  upsertHabitEntryUseCase,
} from "@habit-app/application";
import type { CreateHabitUseCaseInput } from "@habit-app/application";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../database/prisma-client";
import type { PrismaClient } from "../database/prisma-client";
import { PrismaClient as PrismaClientClass } from "../generated/prisma/client";
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
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

describe("ダッシュボード(T-204): listByDateRange と getDashboardUseCase", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let sequence = 0;

  const clock = () => NOW;

  function deps(client: PrismaClient = prisma) {
    return {
      habitRepository: createPrismaHabitRepository(client),
      entryRepository: createPrismaHabitEntryRepository(client),
      profileRepository: createPrismaProfileRepository(client),
      now: clock,
    };
  }

  async function createUser(): Promise<string> {
    sequence += 1;
    const label = `dashboard-user-${sequence}`;
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
      {
        habitRepository: createPrismaHabitRepository(prisma),
        idGenerator: createUuidGenerator(),
        now: clock,
      },
      {
        actorUserId,
        kind: "build",
        name: "水を飲む",
        purpose: "健康維持",
        cue: "起床直後",
        minimumAction: "コップ1杯",
        schedule: { effectiveFrom: "2025-01-01", daysOfWeek: EVERY_DAY, targetCount: 1 },
        ...overrides,
      },
    );
    return record.habit.id;
  }

  /** 統計の対象にしたい日の記録を、use case を介さず直接投入する(対象日の範囲制限を避ける)。 */
  async function record(
    actorUserId: string,
    habitId: string,
    date: string,
    status: "success" | "missed" | "skipped",
  ): Promise<void> {
    const saved = await createPrismaHabitEntryRepository(prisma).upsert({
      actorUserId,
      habitId,
      date,
      status,
      quantity: status === "skipped" ? null : status === "success" ? 1 : 0,
      now: NOW,
    });
    expect(saved).not.toBeNull();
  }

  beforeAll(async () => {
    container = await startPostgresContainer();
    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });
    prisma = createPrismaClient(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  describe("listByDateRange(STAT-INV-001)", () => {
    it("両端を含む範囲だけを日付昇順で返し、習慣は外部 ID で返す", async () => {
      const user = await createUser();
      const habitId = await createHabit(user);
      for (const date of ["2026-01-09", "2026-01-10", "2026-01-12", "2026-01-13", "2026-01-14"]) {
        await record(user, habitId, date, "success");
      }

      const rows = await createPrismaHabitEntryRepository(prisma).listByDateRange({
        actorUserId: user,
        from: "2026-01-10",
        to: "2026-01-13",
      });
      expect(rows.map((r) => r.date)).toEqual(["2026-01-10", "2026-01-12", "2026-01-13"]);
      expect(rows.every((r) => r.habitId === habitId)).toBe(true);
    });

    it("他ユーザーの記録は含まれない", async () => {
      const userA = await createUser();
      const userB = await createUser();
      const habitA = await createHabit(userA);
      const habitB = await createHabit(userB);
      await record(userA, habitA, "2026-01-13", "success");
      await record(userB, habitB, "2026-01-13", "success");

      const rows = await createPrismaHabitEntryRepository(prisma).listByDateRange({
        actorUserId: userA,
        from: "2026-01-01",
        to: TODAY,
      });
      expect(rows.map((r) => r.habitId)).toEqual([habitA]);
    });

    it("形式不正な actor/日付は何も返さない", async () => {
      const repository = createPrismaHabitEntryRepository(prisma);
      expect(
        await repository.listByDateRange({ actorUserId: "abc", from: "2026-01-01", to: TODAY }),
      ).toEqual([]);
      expect(
        await repository.listByDateRange({ actorUserId: "1", from: "2026-1-1", to: TODAY }),
      ).toEqual([]);
    });
  });

  describe("getDashboardUseCase(STAT-001〜005)", () => {
    it("記録も習慣もない新規ユーザーは空状態", async () => {
      const user = await createUser();
      const result = await getDashboardUseCase(deps(), { actorUserId: user });
      expect(result.habits).toEqual([]);
      expect(result.overall.last7Days).toMatchObject({ scheduled: 0, successRate: null });
    });

    it("実 DB の記録から習慣ごとの統計と全体の合算を返し、アーカイブ済みは含めない", async () => {
      const user = await createUser();
      const other = await createUser();
      const a = await createHabit(user, { name: "A" });
      const b = await createHabit(user, { name: "B" });
      const archived = await createHabit(user, { name: "archived" });
      const othersHabit = await createHabit(other, { name: "others" });

      // A: 3 連続 success(1/11〜1/13)、今日は未記録(pending)。それ以前は記録なし(= missed)
      for (const date of ["2026-01-11", "2026-01-12", "2026-01-13"]) {
        await record(user, a, date, "success");
      }
      // B: 1/13 missed、今日 success。それ以前は記録なし(= missed)
      await record(user, b, "2026-01-13", "missed");
      await record(user, b, TODAY, "success");
      await record(user, archived, "2026-01-13", "success");
      await record(other, othersHabit, "2026-01-13", "success");
      const archivedRecord = await createPrismaHabitRepository(prisma).findById({
        actorUserId: user,
        habitId: archived,
      });
      await archiveHabitUseCase(
        { habitRepository: createPrismaHabitRepository(prisma), now: clock },
        { actorUserId: user, habitId: archived, version: archivedRecord?.version ?? 0 },
      );

      const result = await getDashboardUseCase(deps(), { actorUserId: user });

      expect(result.date).toBe(TODAY);
      expect(result.habits.map((h) => h.habit.name)).toEqual(["A", "B"]);
      const [statsA, statsB] = result.habits.map((h) => h.statistics);
      expect(statsA).toMatchObject({
        currentStreak: 3,
        longestStreak: 3,
        last7Days: { scheduled: 7, success: 3, missed: 3, pending: 1, successRate: 0.5 },
      });
      expect(statsB).toMatchObject({
        currentStreak: 1,
        longestStreak: 1,
        last7Days: { scheduled: 7, success: 1, missed: 6, pending: 0 },
      });
      // 全体: success 4 / (4 + missed 9) を合計から求める(アーカイブ済み・他ユーザーは含まない)。
      expect(result.overall.last7Days).toMatchObject({
        scheduled: 14,
        success: 4,
        missed: 9,
        pending: 1,
      });
      expect(result.overall.last7Days.successRate).toBeCloseTo(4 / 13, 10);
    });

    it("use case で記録した内容が反映される(T-202 との往復)", async () => {
      const user = await createUser();
      const habitId = await createHabit(user);
      await upsertHabitEntryUseCase(deps(), {
        actorUserId: user,
        habitId,
        date: TODAY,
        status: "success",
      });
      const result = await getDashboardUseCase(deps(), { actorUserId: user });
      expect(result.habits[0]?.statistics.currentStreak).toBe(1);
    });

    it("DB への問い合わせ回数は習慣数に依らず、記録の取得は 1 回", async () => {
      const queries: string[] = [];
      const logged = new PrismaClientClass({
        adapter: new PrismaPg({ connectionString: container.getConnectionUri() }),
        log: [{ emit: "event", level: "query" }],
      });
      logged.$on("query", (event) => queries.push(event.query));
      try {
        const small = await createUser();
        const large = await createUser();
        await createHabit(small);
        const largeHabitIds: string[] = [];
        for (let i = 0; i < 6; i += 1) largeHabitIds.push(await createHabit(large));
        for (const habitId of largeHabitIds) await record(large, habitId, "2026-01-13", "success");

        // プロフィールの遅延作成の差を除くため、先に 1 回ずつ呼んでプロフィールを作る。
        await getDashboardUseCase(deps(logged), { actorUserId: small });
        await getDashboardUseCase(deps(logged), { actorUserId: large });

        const count = async (actorUserId: string) => {
          queries.length = 0;
          await getDashboardUseCase(deps(logged), { actorUserId });
          const entryQueries = queries.filter((q) => q.includes('FROM "public"."habit_entries"'));
          return { total: queries.length, entries: entryQueries.length };
        };
        const withOne = await count(small);
        const withSix = await count(large);

        expect(withOne.entries).toBe(1);
        expect(withSix.entries).toBe(1);
        expect(withSix.total).toBe(withOne.total);
      } finally {
        await logged.$disconnect();
      }
    });
  });
});
