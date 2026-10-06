import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NotificationUserNotFoundError,
  getNotificationSettingsUseCase,
  upsertNotificationSettingsUseCase,
} from "@habit-app/application";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createPrismaProfileRepository } from "../identity/prisma-profile-repository";
import { createPrismaNotificationSettingsRepository } from "./prisma-notification-settings-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");
const T401_MIGRATION = "20261004000000_t401_notification_settings_constraints";

const NOW = new Date("2026-10-04T03:00:00.000Z");

describe("PrismaNotificationSettingsRepository(T-401)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let userA: string;
  let userB: string;
  let userC: string;

  const settingsRepository = () => createPrismaNotificationSettingsRepository(prisma);
  const deps = () => ({
    settingsRepository: settingsRepository(),
    profileRepository: createPrismaProfileRepository(prisma),
    now: () => NOW,
  });
  const countFor = (userId: string) =>
    prisma.notificationSetting.count({ where: { userId: BigInt(userId) } });

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
    userA = await createUser("notif-user-a");
    userB = await createUser("notif-user-b");
    userC = await createUser("notif-user-c");
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  }, 60_000);

  it("未保存の GET は既定値(無効)を返し、行を作らない", async () => {
    const view = await getNotificationSettingsUseCase(deps(), { actorUserId: userA });
    expect(view).toMatchObject({ enabled: false, localTime: "20:00", updatedAt: null });
    expect(await countFor(userA)).toBe(0);
  });

  it("保存→取得の往復で time 列が HH:mm のまま戻り、createdAt は Clock の値", async () => {
    const saved = await upsertNotificationSettingsUseCase(deps(), {
      actorUserId: userA,
      enabled: true,
      localTime: "07:30",
      timezone: "America/New_York",
    });
    expect(saved).toMatchObject({
      enabled: true,
      localTime: "07:30",
      timezone: "America/New_York",
      quietHours: { start: "22:00", end: "07:00" },
    });
    const found = await getNotificationSettingsUseCase(deps(), { actorUserId: userA });
    expect(found).toEqual(saved);

    const row = await prisma.notificationSetting.findFirstOrThrow({
      where: { userId: BigInt(userA) },
    });
    expect(row.createdAt).toEqual(NOW);
    expect(row.habitId).toBeNull();
    expect(row.channel).toBe("email");
  });

  it("置換と再送では 1 行のまま。quietHours: null と配信停止を保存できる", async () => {
    await upsertNotificationSettingsUseCase(deps(), {
      actorUserId: userB,
      enabled: true,
      localTime: "08:00",
    });
    const replaced = await upsertNotificationSettingsUseCase(deps(), {
      actorUserId: userB,
      enabled: true,
      localTime: "23:15",
      quietHours: null,
    });
    expect(replaced).toMatchObject({ localTime: "23:15", quietHours: null });

    const stopped = await upsertNotificationSettingsUseCase(deps(), {
      actorUserId: userB,
      enabled: false,
      localTime: "23:15",
      quietHours: null,
    });
    const again = await upsertNotificationSettingsUseCase(deps(), {
      actorUserId: userB,
      enabled: false,
      localTime: "23:15",
      quietHours: null,
    });
    expect(stopped.enabled).toBe(false);
    expect({ ...again, updatedAt: undefined }).toEqual({ ...stopped, updatedAt: undefined });
    expect(await countFor(userB)).toBe(1);

    const reenabled = await upsertNotificationSettingsUseCase(deps(), {
      actorUserId: userB,
      enabled: true,
      localTime: "23:15",
      quietHours: null,
    });
    expect(reenabled.enabled).toBe(true);
    expect(await countFor(userB)).toBe(1);
  });

  it("同じ user への並行 upsert はすべて成功し 1 行に収束する", async () => {
    const results = await Promise.allSettled(
      ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"].map((localTime) =>
        upsertNotificationSettingsUseCase(deps(), {
          actorUserId: userC,
          enabled: true,
          localTime,
        }),
      ),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await countFor(userC)).toBe(1);
  });

  it("他ユーザーの設定と混ざらない", async () => {
    const forC = await getNotificationSettingsUseCase(deps(), { actorUserId: userC });
    const forA = await getNotificationSettingsUseCase(deps(), { actorUserId: userA });
    expect(forA.timezone).toBe("America/New_York");
    expect(forC.timezone).toBe("Asia/Tokyo");
  });

  it("habit_id 付きの行は部分 unique index の対象外で、repository はユーザー単位の行だけを扱う", async () => {
    const habit = await prisma.habit.create({
      data: {
        publicId: "00000000-0000-4000-8000-000000000401",
        userId: BigInt(userA),
        kind: "build",
        name: "テスト習慣",
        purpose: "テスト",
        cue: "テスト",
        minimumAction: "テスト",
        status: "active",
      },
    });
    const insertHabitScoped = () =>
      prisma.$executeRaw`
        INSERT INTO notification_settings (user_id, habit_id, local_time, timezone, enabled)
        VALUES (${BigInt(userA)}, ${habit.id}, '06:00'::time, 'Asia/Tokyo', true)`;
    await expect(insertHabitScoped()).resolves.toBeDefined();
    await expect(insertHabitScoped()).resolves.toBeDefined();

    const found = await getNotificationSettingsUseCase(deps(), { actorUserId: userA });
    expect(found.localTime).toBe("07:30");
  });

  it("ユーザー単位の設定を直接重複 INSERT すると一意制約で拒否される", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO notification_settings (user_id, local_time, timezone)
        VALUES (${BigInt(userA)}, '06:00'::time, 'Asia/Tokyo')`,
    ).rejects.toThrow();
  });

  it("存在しない user・形式不正な値は何も書かない", async () => {
    const before = await prisma.notificationSetting.count();
    await expect(
      upsertNotificationSettingsUseCase(deps(), {
        actorUserId: "999999",
        enabled: true,
        localTime: "08:00",
      }),
    ).rejects.toBeInstanceOf(NotificationUserNotFoundError);

    const repo = settingsRepository();
    const base = {
      enabled: true,
      localTime: "08:00",
      timezone: "Asia/Tokyo",
      quietHours: null,
      now: NOW,
    };
    expect(await repo.upsert({ ...base, actorUserId: "not-a-number" })).toBeNull();
    expect(await repo.find({ actorUserId: "0" })).toBeNull();
    expect(await prisma.notificationSetting.count()).toBe(before);
  });

  it("DB の CHECK 制約: channel、quiet hours の片方 NULL、start=end、timezone 長を拒否する", async () => {
    const insert = (
      fields: { channel?: string; start?: string | null; end?: string | null; timezone?: string },
      habitScoped: bigint,
    ) => {
      const channel = fields.channel ?? "email";
      const start = fields.start ?? null;
      const end = fields.end ?? null;
      const timezone = fields.timezone ?? "Asia/Tokyo";
      return prisma.$executeRaw`
        INSERT INTO notification_settings
          (user_id, habit_id, channel, local_time, timezone, quiet_hours_start, quiet_hours_end)
        VALUES (${BigInt(userB)}, ${habitScoped}, ${channel}, '08:00'::time, ${timezone},
                ${start}::time, ${end}::time)`;
    };
    const habit = await prisma.habit.create({
      data: {
        publicId: "00000000-0000-4000-8000-000000000402",
        userId: BigInt(userB),
        kind: "build",
        name: "テスト習慣2",
        purpose: "テスト",
        cue: "テスト",
        minimumAction: "テスト",
        status: "active",
      },
    });
    await expect(insert({ channel: "sms" }, habit.id)).rejects.toThrow();
    await expect(insert({ start: "22:00" }, habit.id)).rejects.toThrow();
    await expect(insert({ end: "07:00" }, habit.id)).rejects.toThrow();
    await expect(insert({ start: "22:00", end: "22:00" }, habit.id)).rejects.toThrow();
    await expect(insert({ timezone: "" }, habit.id)).rejects.toThrow();
    await expect(insert({ timezone: "A".repeat(65) }, habit.id)).rejects.toThrow();
    await expect(insert({ start: "22:00", end: "07:00" }, habit.id)).resolves.toBeDefined();
  });
});

describe("Migration t401 の upgrade(直前の Migration まで適用済みの DB から)", () => {
  it("既存の schema に適用でき、適用後に制約が働く", async () => {
    const upgradeContainer = await startPostgresContainer();
    try {
      // 直前までの Migration だけを一時ディレクトリへコピーして適用し、その後 t401 を適用する。
      const migrationsDir = path.join(infrastructureRoot, "database", "migrations");
      const names = fs
        .readdirSync(migrationsDir)
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
      expect(names).toContain(T401_MIGRATION);

      const env = { ...process.env, DATABASE_URL: upgradeContainer.getConnectionUri() };
      const run = (args: string[]) =>
        execFileSync(prismaCli, [...args, "--config", prismaConfigPath], {
          cwd: infrastructureRoot,
          env,
          stdio: "pipe",
        });
      const before = names.filter((name) => name < T401_MIGRATION);
      const staging = fs.mkdtempSync(path.join(infrastructureRoot, ".t401-upgrade-"));
      try {
        fs.copyFileSync(
          path.join(migrationsDir, "migration_lock.toml"),
          path.join(staging, "migration_lock.toml"),
        );
        for (const name of before) {
          fs.cpSync(path.join(migrationsDir, name), path.join(staging, name), { recursive: true });
        }
        // 一時 Migration ディレクトリを指す config を一時ファイルとして作る(本物の config は変更しない)。
        const stagingConfig = path.join(infrastructureRoot, ".t401-upgrade.config.ts");
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
        try {
          execFileSync(prismaCli, ["migrate", "deploy", "--config", stagingConfig], {
            cwd: infrastructureRoot,
            env,
            stdio: "pipe",
          });
        } finally {
          fs.rmSync(stagingConfig, { force: true });
        }
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }

      run(["migrate", "deploy"]);

      const client = createPrismaClient(upgradeContainer.getConnectionUri());
      try {
        const indexes = await client.$queryRaw<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes
          WHERE indexname = 'notification_settings_user_default_uidx'`;
        expect(indexes).toHaveLength(1);
      } finally {
        await client.$disconnect();
      }
    } finally {
      await upgradeContainer.stop();
    }
  }, 180_000);
});
