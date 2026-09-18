import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "./prisma-client";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");

describe("baseline schema (T-004)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await startPostgresContainer();

    // fresh: 新規DBへの初期migration適用を検証する。
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

  it("build習慣を作成し、初期スケジュールと予定機会を登録できる(正常系CRUD)", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: "sub-crud",
        emailNormalized: "crud@example.com",
        passwordHash: "argon2id$dummy-hash-crud",
        profile: {
          create: {
            displayName: "テスト太郎",
            timezone: "Asia/Tokyo",
            locale: "ja",
            weekStartsOn: 1,
          },
        },
      },
    });

    const habit = await prisma.habit.create({
      data: {
        userId: user.id,
        kind: "build",
        name: "朝に本を読む",
        purpose: "学習を日常化する",
        cue: "朝食後",
        minimumAction: "1ページ読む",
        scheduleVersions: {
          create: {
            effectiveFrom: new Date("2026-01-01"),
            daysOfWeek: [1, 2, 3, 4, 5],
            targetCount: 1,
          },
        },
      },
      include: { scheduleVersions: true },
    });

    const entry = await prisma.habitEntry.create({
      data: {
        userId: user.id,
        habitId: habit.id,
        habitDate: new Date("2026-01-05"),
        status: "success",
        quantity: 1,
      },
    });

    expect(habit.scheduleVersions).toHaveLength(1);
    expect(entry.status).toBe("success");
  });

  it("不正なstatusはCHECK制約で拒否される", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: "sub-check",
        emailNormalized: "check@example.com",
        passwordHash: "argon2id$dummy-hash-check",
      },
    });

    await expect(
      prisma.$executeRaw`UPDATE users SET status = 'invalid_status' WHERE id = ${user.id}`,
    ).rejects.toThrow();
  });

  it("同一habitのスケジュール期間重複はexclusion制約で拒否される", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: "sub-overlap",
        emailNormalized: "overlap@example.com",
        passwordHash: "argon2id$dummy-hash-overlap",
      },
    });
    const habit = await prisma.habit.create({
      data: {
        userId: user.id,
        kind: "build",
        name: "水を飲む",
        purpose: "健康",
        cue: "起床後",
        minimumAction: "コップ1杯",
        scheduleVersions: {
          create: { effectiveFrom: new Date("2026-01-01"), daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
        },
      },
    });

    await expect(
      prisma.habitScheduleVersion.create({
        data: {
          habitId: habit.id,
          effectiveFrom: new Date("2026-06-01"),
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        },
      }),
    ).rejects.toThrow();
  });

  it("重複しない期間のスケジュール追加は成功する", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: "sub-sequential",
        emailNormalized: "sequential@example.com",
        passwordHash: "argon2id$dummy-hash-sequential",
      },
    });
    const habit = await prisma.habit.create({
      data: {
        userId: user.id,
        kind: "build",
        name: "ストレッチ",
        purpose: "柔軟性",
        cue: "就寝前",
        minimumAction: "1分",
        scheduleVersions: {
          create: {
            effectiveFrom: new Date("2026-01-01"),
            effectiveTo: new Date("2026-05-31"),
            daysOfWeek: [1, 3, 5],
          },
        },
      },
    });

    const secondVersion = await prisma.habitScheduleVersion.create({
      data: {
        habitId: habit.id,
        effectiveFrom: new Date("2026-06-01"),
        daysOfWeek: [1, 3, 5],
      },
    });

    expect(secondVersion.habitId).toBe(habit.id);
  });
});
