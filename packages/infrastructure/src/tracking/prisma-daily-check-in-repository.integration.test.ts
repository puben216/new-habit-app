import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DailyCheckInNotFoundError,
  UserNotFoundError,
  getDailyCheckInUseCase,
  upsertDailyCheckInUseCase,
} from "@habit-app/application";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createPrismaProfileRepository } from "../identity/prisma-profile-repository";
import { createPrismaDailyCheckInRepository } from "./prisma-daily-check-in-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");

// 2026-01-14(水)12:00 JST。
const NOW = new Date("2026-01-14T03:00:00.000Z");
const TODAY = "2026-01-14";

describe("PrismaDailyCheckInRepository(T-203)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let userA: string;
  let userB: string;

  const checkInRepository = () => createPrismaDailyCheckInRepository(prisma);
  const upsertDeps = () => ({
    checkInRepository: checkInRepository(),
    profileRepository: createPrismaProfileRepository(prisma),
    now: () => NOW,
  });
  const countFor = (userId: string, date: string) =>
    prisma.dailyCheckIn.count({
      where: { userId: BigInt(userId), checkInDate: new Date(`${date}T00:00:00.000Z`) },
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

  beforeAll(async () => {
    container = await startPostgresContainer();
    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });
    prisma = createPrismaClient(container.getConnectionUri());
    userA = await createUser("checkin-user-a");
    userB = await createUser("checkin-user-b");
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it("保存→取得の往復で同じ内容が得られ、createdAt は Clock の値", async () => {
    const saved = await upsertDailyCheckInUseCase(upsertDeps(), {
      actorUserId: userA,
      date: TODAY,
      mood: 4,
      difficulty: 2,
      note: "歩いた\n夕方にも",
    });
    expect(saved).toMatchObject({ date: TODAY, mood: 4, difficulty: 2, note: "歩いた\n夕方にも" });
    expect(saved.createdAt).toEqual(NOW);

    const found = await getDailyCheckInUseCase(
      { checkInRepository: checkInRepository() },
      { actorUserId: userA, date: TODAY },
    );
    expect(found).toEqual(saved);
  });

  it("訂正は全項目を置換し、再送でもレコードは 1 件のまま", async () => {
    const date = "2026-01-13";
    const first = await upsertDailyCheckInUseCase(upsertDeps(), {
      actorUserId: userA,
      date,
      mood: 4,
      difficulty: 2,
      note: "メモ",
    });
    const replaced = await upsertDailyCheckInUseCase(upsertDeps(), {
      actorUserId: userA,
      date,
      mood: 5,
    });
    expect(replaced).toMatchObject({ mood: 5, difficulty: null, note: null });
    expect(replaced.createdAt).toEqual(first.createdAt);

    const again = await upsertDailyCheckInUseCase(upsertDeps(), {
      actorUserId: userA,
      date,
      mood: 5,
    });
    // 更新時の updated_at は DB の set_updated_at trigger(CURRENT_TIMESTAMP)が決める。
    expect({ ...again, updatedAt: undefined }).toEqual({ ...replaced, updatedAt: undefined });
    expect(await countFor(userA, date)).toBe(1);
  });

  it("同じ (user, date) への並行 upsert はすべて成功し 1 レコードに収束する", async () => {
    const date = "2026-01-12";
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 1].map((mood) =>
        upsertDailyCheckInUseCase(upsertDeps(), { actorUserId: userA, date, mood }),
      ),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await countFor(userA, date)).toBe(1);
  });

  it("同じ日の他ユーザーのチェックインと混ざらない(取得も更新も自分の分のみ)", async () => {
    const date = "2026-01-10";
    await upsertDailyCheckInUseCase(upsertDeps(), { actorUserId: userA, date, mood: 1 });
    await expect(
      getDailyCheckInUseCase(
        { checkInRepository: checkInRepository() },
        { actorUserId: userB, date },
      ),
    ).rejects.toBeInstanceOf(DailyCheckInNotFoundError);

    await upsertDailyCheckInUseCase(upsertDeps(), { actorUserId: userB, date, mood: 5 });
    const forA = await getDailyCheckInUseCase(
      { checkInRepository: checkInRepository() },
      { actorUserId: userA, date },
    );
    expect(forA.mood).toBe(1);
  });

  it("存在しない user・形式不正な値は何も書かない", async () => {
    const before = await prisma.dailyCheckIn.count();
    await expect(
      upsertDailyCheckInUseCase(upsertDeps(), { actorUserId: "999999", date: TODAY, mood: 3 }),
    ).rejects.toBeInstanceOf(UserNotFoundError);

    const repo = checkInRepository();
    const base = { date: TODAY, mood: 3, difficulty: null, note: null, now: NOW };
    expect(await repo.upsert({ ...base, actorUserId: "not-a-number" })).toBeNull();
    expect(await repo.upsert({ ...base, actorUserId: userA, date: "2026-1-1" })).toBeNull();
    expect(await repo.find({ actorUserId: userA, date: "bad" })).toBeNull();
    expect(await prisma.dailyCheckIn.count()).toBe(before);
  });

  it("DB の CHECK 制約: mood/difficulty の 0 と 6 は拒否され、1 と 5 は受理される", async () => {
    const insert = (mood: number, difficulty: number, day: number) =>
      prisma.$executeRaw`
        INSERT INTO daily_check_ins (user_id, check_in_date, mood, difficulty)
        VALUES (${BigInt(userA)}, ${new Date(Date.UTC(2025, 0, day))}::date,
                ${mood}::smallint, ${difficulty}::smallint)`;
    await expect(insert(0, 3, 1)).rejects.toThrow();
    await expect(insert(6, 3, 2)).rejects.toThrow();
    await expect(insert(3, 0, 3)).rejects.toThrow();
    await expect(insert(3, 6, 4)).rejects.toThrow();
    await expect(insert(1, 5, 5)).resolves.toBeDefined();
  });
});
