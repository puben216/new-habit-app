import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UserNotFoundError,
  WeeklyReviewAlreadyCompletedError,
  WeeklyReviewNotFoundError,
  createHabitUseCase,
  createWeeklyReviewUseCase,
  getWeeklyReviewUseCase,
  listWeeklyReviewsUseCase,
  updateWeeklyReviewUseCase,
} from "@habit-app/application";
import type { CreateHabitUseCaseInput } from "@habit-app/application";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../database/prisma-client";
import type { PrismaClient } from "../database/prisma-client";
import { createPrismaHabitRepository } from "../habits/prisma-habit-repository";
import { createUuidGenerator } from "../habits/uuid-generator";
import { createPrismaProfileRepository } from "../identity/prisma-profile-repository";
import { createPrismaDailyCheckInRepository } from "./prisma-daily-check-in-repository";
import { createPrismaHabitEntryRepository } from "./prisma-habit-entry-repository";
import { createPrismaWeeklyReviewRepository } from "./prisma-weekly-review-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");
const T301_MIGRATION = "20261005000000_t301_weekly_review_constraints";

// 2026-01-14(水)12:00 JST。週(月曜始まり)は 2026-01-05(月)〜2026-01-11(日)。
const NOW = new Date("2026-01-14T03:00:00.000Z");
const WEEK = "2026-01-05";
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const clock = () => NOW;

function migrateDeploy(connectionUri: string): void {
  execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
    cwd: infrastructureRoot,
    env: { ...process.env, DATABASE_URL: connectionUri },
    stdio: "pipe",
  });
}

describe("PrismaWeeklyReviewRepository(T-301)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let sequence = 0;

  function createDeps(client: PrismaClient = prisma) {
    return {
      reviewRepository: createPrismaWeeklyReviewRepository(client),
      habitRepository: createPrismaHabitRepository(client),
      entryRepository: createPrismaHabitEntryRepository(client),
      checkInRepository: createPrismaDailyCheckInRepository(client),
      profileRepository: createPrismaProfileRepository(client),
      now: clock,
    };
  }
  const reviewDeps = () => ({
    reviewRepository: createPrismaWeeklyReviewRepository(prisma),
    now: clock,
  });

  async function createUser(): Promise<string> {
    sequence += 1;
    const label = `weekly-review-user-${sequence}`;
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

  async function checkIn(
    actorUserId: string,
    date: string,
    mood: number | null,
    difficulty: number | null,
    note: string | null = null,
  ): Promise<void> {
    const saved = await createPrismaDailyCheckInRepository(prisma).upsert({
      actorUserId,
      date,
      mood,
      difficulty,
      note,
      now: NOW,
    });
    expect(saved).not.toBeNull();
  }

  const rowCount = (userId: string) =>
    prisma.weeklyReview.count({ where: { userId: BigInt(userId) } });

  beforeAll(async () => {
    container = await startPostgresContainer();
    migrateDeploy(container.getConnectionUri());
    prisma = createPrismaClient(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  describe("作成とスナップショット(WREV-001/003)", () => {
    it("実 DB の習慣・記録・チェックインから期待どおりの summary を作り、往復できる", async () => {
      const userId = await createUser();
      const water = await createHabit(userId, { name: "水を飲む" });
      const walk = await createHabit(userId, {
        name: "散歩",
        schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [1, 3], targetCount: 1 },
      });
      for (const [day, status] of [
        ["2026-01-05", "success"],
        ["2026-01-06", "success"],
        ["2026-01-07", "success"],
        ["2026-01-08", "success"],
        ["2026-01-09", "skipped"],
      ] as const) {
        await record(userId, water, day, status);
      }
      await record(userId, walk, "2026-01-05", "success");
      await record(userId, walk, "2026-01-12", "success"); // 翌週は対象外
      await checkIn(userId, "2026-01-06", 4, 3, "メモは含めない");
      await checkIn(userId, "2026-01-08", 2, null);
      await checkIn(userId, "2026-01-04", 5, 5); // 前週は対象外
      await checkIn(userId, "2026-01-12", 5, 5); // 翌週は対象外

      const { review, created } = await createWeeklyReviewUseCase(createDeps(), {
        actorUserId: userId,
        weekStart: WEEK,
      });

      expect(created).toBe(true);
      expect(review).toMatchObject({
        weekStart: WEEK,
        weekEnd: "2026-01-11",
        timezone: "Asia/Tokyo",
        status: "draft",
        reflection: null,
        completedAt: null,
      });
      expect(review.createdAt).toEqual(NOW);
      expect(review.summary.habits.map((habit) => habit.name)).toEqual(["水を飲む", "散歩"]);
      expect(review.summary.habits[0]).toMatchObject({
        habitId: water,
        scheduled: 7,
        success: 4,
        skipped: 1,
        missed: 2,
        pending: 0,
      });
      expect(review.summary.habits[1]).toMatchObject({
        habitId: walk,
        scheduled: 2,
        success: 1,
        missed: 1,
      });
      expect(review.summary.overall).toEqual({
        scheduled: 9,
        success: 5,
        missed: 3,
        skipped: 1,
        pending: 0,
        successRate: 5 / 8,
      });
      expect(review.summary.checkIn).toEqual({ days: 2, averageMood: 3, averageDifficulty: 3 });
      expect(JSON.stringify(review.summary)).not.toContain("メモは含めない");
      expect(JSON.stringify(review.summary)).not.toContain("健康維持");

      const fetched = await getWeeklyReviewUseCase(reviewDeps(), {
        actorUserId: userId,
        reviewId: review.id,
      });
      expect(fetched).toEqual(review);
    });

    it("同じ週の再作成は既存を返し、記録を訂正してもスナップショットは変わらない", async () => {
      const userId = await createUser();
      const habitId = await createHabit(userId);
      const first = await createWeeklyReviewUseCase(createDeps(), {
        actorUserId: userId,
        weekStart: WEEK,
      });
      await record(userId, habitId, "2026-01-05", "success");

      const second = await createWeeklyReviewUseCase(createDeps(), {
        actorUserId: userId,
        weekStart: WEEK,
      });
      expect(second.created).toBe(false);
      expect(second.review).toEqual(first.review);
      expect(second.review.summary.overall.success).toBe(0);
      expect(await rowCount(userId)).toBe(1);
    });

    it("並行して同じ週を 6 件作成しても 1 行で、created は 1 件のみ、全員が同じ ID を得る", async () => {
      const userId = await createUser();
      await createHabit(userId);
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          createWeeklyReviewUseCase(createDeps(), { actorUserId: userId, weekStart: WEEK }),
        ),
      );
      expect(await rowCount(userId)).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.review.id)).size).toBe(1);
    });

    it("user が存在しなければ UserNotFoundError で何も作られない(FK 違反を表に出さない)", async () => {
      const before = await prisma.weeklyReview.count();
      await expect(
        createWeeklyReviewUseCase(createDeps(), { actorUserId: "999999", weekStart: WEEK }),
      ).rejects.toBeInstanceOf(UserNotFoundError);
      expect(await prisma.weeklyReview.count()).toBe(before);
    });

    it("他ユーザーの習慣・記録・チェックインは集計に混ざらず、同じ週でもレビューは別々", async () => {
      const userA = await createUser();
      const userB = await createUser();
      const habitA = await createHabit(userA, { name: "Aの習慣" });
      const habitB = await createHabit(userB, { name: "Bの習慣" });
      await record(userA, habitA, "2026-01-05", "success");
      await record(userB, habitB, "2026-01-05", "success");
      await record(userB, habitB, "2026-01-06", "success");
      await checkIn(userB, "2026-01-06", 5, 5);

      const reviewA = await createWeeklyReviewUseCase(createDeps(), {
        actorUserId: userA,
        weekStart: WEEK,
      });
      const reviewB = await createWeeklyReviewUseCase(createDeps(), {
        actorUserId: userB,
        weekStart: WEEK,
      });

      expect(reviewA.created && reviewB.created).toBe(true);
      expect(reviewA.review.id).not.toBe(reviewB.review.id);
      expect(reviewA.review.summary.habits.map((habit) => habit.name)).toEqual(["Aの習慣"]);
      expect(reviewA.review.summary.overall.success).toBe(1);
      expect(reviewA.review.summary.checkIn.days).toBe(0);
      expect(reviewB.review.summary.overall.success).toBe(2);
    });
  });

  describe("取得と一覧(WREV-004)", () => {
    it("他ユーザーのレビューは取得できず(404 相当)、一覧にも出ない", async () => {
      const userA = await createUser();
      const userB = await createUser();
      const { review } = await createWeeklyReviewUseCase(createDeps(), {
        actorUserId: userA,
        weekStart: WEEK,
      });
      await expect(
        getWeeklyReviewUseCase(reviewDeps(), { actorUserId: userB, reviewId: review.id }),
      ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
      const list = await listWeeklyReviewsUseCase(reviewDeps(), { actorUserId: userB, limit: 20 });
      expect(list.items).toEqual([]);
    });

    it("UUID 形式でない ID・存在しない UUID は not found", async () => {
      const userId = await createUser();
      for (const reviewId of [
        "1",
        "abc",
        "'; DROP TABLE weekly_reviews;--",
        "00000000-0000-4000-8000-000000000000",
      ]) {
        await expect(
          getWeeklyReviewUseCase(reviewDeps(), { actorUserId: userId, reviewId }),
        ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
      }
    });

    it("weekStart の新しい順にページングし、重複・欠落がない", async () => {
      const userId = await createUser();
      const weeks = ["2025-12-15", "2025-12-22", "2025-12-29", "2026-01-05"];
      for (const weekStart of [weeks[1], weeks[3], weeks[0], weeks[2]]) {
        await createWeeklyReviewUseCase(createDeps(), {
          actorUserId: userId,
          weekStart: weekStart ?? "",
        });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listWeeklyReviewsUseCase(reviewDeps(), {
          actorUserId: userId,
          limit: 3,
          cursor,
        });
        seen.push(...page.items.map((item) => item.weekStart));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined);

      expect(seen).toEqual([...weeks].reverse());
      expect(pages).toBe(2);
    });
  });

  describe("更新と確定(WREV-005)", () => {
    async function newDraft(): Promise<{ userId: string; reviewId: string }> {
      const userId = await createUser();
      const { review } = await createWeeklyReviewUseCase(createDeps(), {
        actorUserId: userId,
        weekStart: WEEK,
      });
      return { userId, reviewId: review.id };
    }

    it("draft の間は更新でき、確定すると completed になり、以後は変更できない", async () => {
      const { userId, reviewId } = await newDraft();
      const updated = await updateWeeklyReviewUseCase(reviewDeps(), {
        actorUserId: userId,
        reviewId,
        reflection: "  よく続いた  ",
        complete: false,
      });
      expect(updated).toMatchObject({
        reflection: "よく続いた",
        status: "draft",
        completedAt: null,
      });

      const completed = await updateWeeklyReviewUseCase(reviewDeps(), {
        actorUserId: userId,
        reviewId,
        complete: true,
      });
      expect(completed).toMatchObject({ reflection: "よく続いた", status: "completed" });
      expect(completed.completedAt).toEqual(NOW);
      expect(completed.summary).toEqual(updated.summary);

      await expect(
        updateWeeklyReviewUseCase(reviewDeps(), {
          actorUserId: userId,
          reviewId,
          reflection: "追記",
          complete: false,
        }),
      ).rejects.toBeInstanceOf(WeeklyReviewAlreadyCompletedError);
      const after = await getWeeklyReviewUseCase(reviewDeps(), { actorUserId: userId, reviewId });
      expect(after.reflection).toBe("よく続いた");
    });

    it("null でクリアでき、省略した項目は変更されない", async () => {
      const { userId, reviewId } = await newDraft();
      await updateWeeklyReviewUseCase(reviewDeps(), {
        actorUserId: userId,
        reviewId,
        reflection: "メモ",
        complete: false,
      });
      const cleared = await updateWeeklyReviewUseCase(reviewDeps(), {
        actorUserId: userId,
        reviewId,
        reflection: null,
        complete: false,
      });
      expect(cleared.reflection).toBeNull();

      await updateWeeklyReviewUseCase(reviewDeps(), {
        actorUserId: userId,
        reviewId,
        reflection: "残す",
        complete: false,
      });
      const completed = await updateWeeklyReviewUseCase(reviewDeps(), {
        actorUserId: userId,
        reviewId,
        complete: true,
      });
      expect(completed.reflection).toBe("残す");
    });

    it("並行して確定を 6 件送っても 1 回だけ成功し、残りは確定済みエラー", async () => {
      const { userId, reviewId } = await newDraft();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          updateWeeklyReviewUseCase(reviewDeps(), {
            actorUserId: userId,
            reviewId,
            reflection: `振り返り${index}`,
            complete: true,
          }),
        ),
      );
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(5);
      for (const result of rejected) {
        expect(result.reason).toBeInstanceOf(WeeklyReviewAlreadyCompletedError);
      }
      const winner = fulfilled[0];
      const stored = await getWeeklyReviewUseCase(reviewDeps(), { actorUserId: userId, reviewId });
      expect(stored.status).toBe("completed");
      expect(winner?.status === "fulfilled" ? winner.value.reflection : null).toBe(
        stored.reflection,
      );
    });

    it("他人のレビューは更新できず、内容も変わらない", async () => {
      const { userId, reviewId } = await newDraft();
      const attacker = await createUser();
      await expect(
        updateWeeklyReviewUseCase(reviewDeps(), {
          actorUserId: attacker,
          reviewId,
          reflection: "乗っ取り",
          complete: true,
        }),
      ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
      const stored = await getWeeklyReviewUseCase(reviewDeps(), { actorUserId: userId, reviewId });
      expect(stored).toMatchObject({ status: "draft", reflection: null });
    });
  });

  describe("DB 制約(WREV-INV-006)", () => {
    async function insert(overrides: {
      status?: string;
      completedAt?: Date | null;
      reflection?: string | null;
      timezone?: string;
      summary?: string;
      weekStart?: string;
    }): Promise<void> {
      const userId = BigInt(await createUser());
      await prisma.$executeRaw`
        INSERT INTO weekly_reviews
          (user_id, week_start, timezone_snapshot, summary_json, reflection, status, completed_at)
        VALUES (${userId}, ${new Date(`${overrides.weekStart ?? WEEK}T00:00:00.000Z`)}::date,
                ${overrides.timezone ?? "Asia/Tokyo"}, ${overrides.summary ?? "{}"}::jsonb,
                ${overrides.reflection ?? null}, ${overrides.status ?? "draft"},
                ${overrides.completedAt ?? null})`;
    }

    it("妥当な行は挿入できる", async () => {
      await expect(insert({})).resolves.toBeUndefined();
      await expect(insert({ status: "completed", completedAt: NOW })).resolves.toBeUndefined();
      await expect(insert({ reflection: "あ".repeat(1000) })).resolves.toBeUndefined();
    });

    it("status と completed_at が不整合な行は拒否される", async () => {
      await expect(insert({ status: "completed", completedAt: null })).rejects.toThrow();
      await expect(insert({ status: "draft", completedAt: NOW })).rejects.toThrow();
    });

    it("reflection が空文字・1001 文字の行は拒否される", async () => {
      await expect(insert({ reflection: "" })).rejects.toThrow();
      await expect(insert({ reflection: "あ".repeat(1001) })).rejects.toThrow();
    });

    it("timezone_snapshot が空・65 文字の行、summary_json が object でない行は拒否される", async () => {
      await expect(insert({ timezone: "" })).rejects.toThrow();
      await expect(insert({ timezone: "a".repeat(65) })).rejects.toThrow();
      await expect(insert({ summary: "[]" })).rejects.toThrow();
      await expect(insert({ summary: "null" })).rejects.toThrow();
      await expect(insert({ summary: '"text"' })).rejects.toThrow();
    });

    it("同じ (user, week_start) の重複は unique 制約で拒否される", async () => {
      const userId = BigInt(await createUser());
      const weekStart = new Date(`${WEEK}T00:00:00.000Z`);
      const insertOnce = () =>
        prisma.$executeRaw`
          INSERT INTO weekly_reviews (user_id, week_start, timezone_snapshot, summary_json)
          VALUES (${userId}, ${weekStart}::date, 'Asia/Tokyo', '{}'::jsonb)`;
      await insertOnce();
      await expect(insertOnce()).rejects.toThrow();
    });
  });

  describe("DailyCheckInRepository.listByDateRange", () => {
    it("両端を含み、範囲外と他ユーザー分を除き、日付の昇順で返す", async () => {
      const userA = await createUser();
      const userB = await createUser();
      for (const date of ["2026-01-04", "2026-01-05", "2026-01-11", "2026-01-12", "2026-01-08"]) {
        await checkIn(userA, date, 3, null);
      }
      await checkIn(userB, "2026-01-06", 1, 1);

      const repository = createPrismaDailyCheckInRepository(prisma);
      const rows = await repository.listByDateRange({
        actorUserId: userA,
        from: "2026-01-05",
        to: "2026-01-11",
      });
      expect(rows.map((row) => row.date)).toEqual(["2026-01-05", "2026-01-08", "2026-01-11"]);
      expect(
        await repository.listByDateRange({
          actorUserId: "abc",
          from: "2026-01-05",
          to: "2026-01-11",
        }),
      ).toEqual([]);
    });
  });
});

describe("Migration t301 の upgrade(直前の Migration まで適用済みの DB から)", () => {
  it("既存の schema(既存行あり)に適用でき、適用後に制約が働く", async () => {
    const upgradeContainer = await startPostgresContainer();
    try {
      const migrationsDir = path.join(infrastructureRoot, "database", "migrations");
      const names = fs
        .readdirSync(migrationsDir)
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
      expect(names).toContain(T301_MIGRATION);

      const env = { ...process.env, DATABASE_URL: upgradeContainer.getConnectionUri() };
      const before = names.filter((name) => name < T301_MIGRATION);
      const staging = fs.mkdtempSync(path.join(infrastructureRoot, ".t301-upgrade-"));
      const stagingConfig = path.join(infrastructureRoot, ".t301-upgrade.config.ts");
      try {
        fs.copyFileSync(
          path.join(migrationsDir, "migration_lock.toml"),
          path.join(staging, "migration_lock.toml"),
        );
        for (const name of before) {
          fs.cpSync(path.join(migrationsDir, name), path.join(staging, name), { recursive: true });
        }
        // 一時 Migration ディレクトリを指す config を一時ファイルとして作る(本物の config は変更しない)。
        fs.writeFileSync(
          stagingConfig,
          `import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "database/schema.prisma",
  migrations: { path: ${JSON.stringify(staging)} },
  datasource: { url: process.env["DATABASE_URL"] },
});
`,
        );
        execFileSync(prismaCli, ["migrate", "deploy", "--config", stagingConfig], {
          cwd: infrastructureRoot,
          env,
          stdio: "pipe",
        });
      } finally {
        fs.rmSync(stagingConfig, { force: true });
        fs.rmSync(staging, { recursive: true, force: true });
      }

      // t301 適用前の schema に、制約に適合する既存行を入れておく。
      const client = createPrismaClient(upgradeContainer.getConnectionUri());
      try {
        const user = await client.user.create({
          data: {
            authSubject: "credentials:upgrade@example.com",
            emailNormalized: "upgrade@example.com",
            passwordHash: "hash",
          },
        });
        await client.$executeRaw`
          INSERT INTO weekly_reviews (user_id, week_start, timezone_snapshot, summary_json)
          VALUES (${user.id}, '2026-01-05'::date, 'Asia/Tokyo', '{}'::jsonb)`;

        migrateDeploy(upgradeContainer.getConnectionUri());

        // 既存行は保持される。
        expect(await client.weeklyReview.count({ where: { userId: user.id } })).toBe(1);
        // 制約が働く。
        await expect(
          client.$executeRaw`
            INSERT INTO weekly_reviews (user_id, week_start, timezone_snapshot, summary_json, status)
            VALUES (${user.id}, '2026-01-12'::date, 'Asia/Tokyo', '{}'::jsonb, 'completed')`,
        ).rejects.toThrow();
        const constraints = await client.$queryRaw<{ conname: string }[]>`
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'weekly_reviews'::regclass AND conname LIKE 'weekly_reviews_%_check'
          ORDER BY conname`;
        expect(constraints.map((row) => row.conname)).toEqual([
          "weekly_reviews_completed_at_check",
          "weekly_reviews_reflection_length_check",
          "weekly_reviews_status_check",
          "weekly_reviews_summary_object_check",
          "weekly_reviews_timezone_check",
        ]);
      } finally {
        await client.$disconnect();
      }
    } finally {
      await upgradeContainer.stop();
    }
  }, 180_000);
});
