import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProfile } from "@habit-app/domain";
import { startPostgresContainer } from "@habit-app/test-support";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createPrismaProfileRepository } from "./prisma-profile-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");
const migrationsRoot = path.join(infrastructureRoot, "database", "migrations");

describe("PrismaProfileRepository(T-102)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await startPostgresContainer();

    // fresh: 新規 DB へ全 migration を適用する。
    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });

    prisma = createPrismaClient(container.getConnectionUri());
  }, 120_000);

  afterEach(async () => {
    await prisma.userProfile.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  async function createUser(label: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}@example.com`,
        emailNormalized: `${label}@example.com`,
        passwordHash: "argon2id$dummy-hash",
      },
    });
    return user.id.toString();
  }

  describe("ensure(PROF-001/006/INV-001)", () => {
    it("未作成なら既定値で作成して返す", async () => {
      const userId = await createUser("ensure-default");
      const repository = createPrismaProfileRepository(prisma);

      const record = await repository.ensure(userId, createDefaultProfile());

      expect(record).toMatchObject({
        userId,
        displayName: null,
        timezone: "Asia/Tokyo",
        locale: "ja",
        weekStartsOn: 1,
      });
    });

    it("作成済みの行を上書きしない", async () => {
      const userId = await createUser("ensure-keep");
      const repository = createPrismaProfileRepository(prisma);
      await repository.ensure(userId, createDefaultProfile());
      await repository.update(userId, { displayName: "既存", timezone: "America/New_York" });

      const record = await repository.ensure(userId, createDefaultProfile());

      expect(record).toMatchObject({ displayName: "既存", timezone: "America/New_York" });
    });

    it("並行した初回アクセスでも 1 行のみ作成され、すべて成功する", async () => {
      const userId = await createUser("ensure-concurrent");
      const repository = createPrismaProfileRepository(prisma);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => repository.ensure(userId, createDefaultProfile())),
      );

      expect(results.every((record) => record?.userId === userId)).toBe(true);
      await expect(prisma.userProfile.count()).resolves.toBe(1);
    });

    it("user が存在しない場合は null を返し、行を作らない", async () => {
      const repository = createPrismaProfileRepository(prisma);

      await expect(repository.ensure("999999", createDefaultProfile())).resolves.toBeNull();
      await expect(repository.ensure("not-a-number", createDefaultProfile())).resolves.toBeNull();
      await expect(prisma.userProfile.count()).resolves.toBe(0);
    });
  });

  describe("update(PROF-002/007)", () => {
    it("指定項目のみ更新し、他の項目は変更しない", async () => {
      const userId = await createUser("update-partial");
      const repository = createPrismaProfileRepository(prisma);
      await repository.ensure(userId, createDefaultProfile());

      const record = await repository.update(userId, { displayName: "たなか", weekStartsOn: 0 });

      expect(record).toMatchObject({
        displayName: "たなか",
        weekStartsOn: 0,
        timezone: "Asia/Tokyo",
        locale: "ja",
      });
    });

    it("更新すると updatedAt が進む", async () => {
      const userId = await createUser("update-timestamp");
      const repository = createPrismaProfileRepository(prisma);
      const created = await repository.ensure(userId, createDefaultProfile());

      const updated = await repository.update(userId, { locale: "en" });

      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());
    });

    it("user A の更新は user B のプロフィールを変更しない(ownership)", async () => {
      const userA = await createUser("owner-a");
      const userB = await createUser("owner-b");
      const repository = createPrismaProfileRepository(prisma);
      await repository.ensure(userA, createDefaultProfile());
      await repository.ensure(userB, createDefaultProfile());
      await repository.update(userB, { displayName: "ユーザーB", timezone: "Europe/London" });

      await repository.update(userA, { displayName: "ユーザーA", timezone: "America/New_York" });

      const rowB = await repository.ensure(userB, createDefaultProfile());
      expect(rowB).toMatchObject({
        userId: userB,
        displayName: "ユーザーB",
        timezone: "Europe/London",
      });
    });

    it("対象行が存在しない場合は null を返す", async () => {
      const userId = await createUser("update-missing");
      const repository = createPrismaProfileRepository(prisma);

      await expect(repository.update(userId, { displayName: "x" })).resolves.toBeNull();
      await expect(repository.update("999999", { displayName: "x" })).resolves.toBeNull();
    });
  });

  describe("DB 制約(PROF-INV-002/003/004)", () => {
    async function insertRaw(
      userId: string,
      values: {
        displayName: string | null;
        timezone: string;
        locale: string;
        weekStartsOn: number;
      },
    ): Promise<void> {
      await prisma.$executeRaw`
        INSERT INTO user_profiles (user_id, display_name, timezone, locale, week_starts_on)
        VALUES (${BigInt(userId)}, ${values.displayName}, ${values.timezone}, ${values.locale}, ${values.weekStartsOn})
      `;
    }

    const valid = { displayName: "ok", timezone: "Asia/Tokyo", locale: "ja", weekStartsOn: 1 };

    it("制約を満たす行(display_name が NULL を含む)は保存できる", async () => {
      const userId = await createUser("check-valid");
      await expect(insertRaw(userId, { ...valid, displayName: null })).resolves.toBeUndefined();
    });

    it.each([
      ["display_name が空文字", { displayName: "" }],
      ["display_name が 51 文字", { displayName: "a".repeat(51) }],
      ["timezone が空文字", { timezone: "" }],
      ["timezone が 65 文字", { timezone: "a".repeat(65) }],
      ["locale が未対応", { locale: "fr" }],
      ["week_starts_on が -1", { weekStartsOn: -1 }],
      ["week_starts_on が 7", { weekStartsOn: 7 }],
    ])("CHECK 制約違反を拒否する: %s", async (_label, override) => {
      const userId = await createUser("check-invalid");

      await expect(insertRaw(userId, { ...valid, ...override })).rejects.toThrow();
      await expect(prisma.userProfile.count()).resolves.toBe(0);
    });

    it("display_name 50 文字(code point)と week_starts_on 0/6 は保存できる", async () => {
      const userId = await createUser("check-boundary");

      await expect(
        insertRaw(userId, { ...valid, displayName: "😀".repeat(50), weekStartsOn: 6 }),
      ).resolves.toBeUndefined();
    });
  });
});

describe("user_profiles 制約 migration の upgrade(T-102)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await startPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it("T-101 時点の schema(既存行あり)へ本 migration を適用でき、既存行が保持される", async () => {
    const client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    try {
      const apply = async (name: string): Promise<void> => {
        await client.query(readFileSync(path.join(migrationsRoot, name, "migration.sql"), "utf8"));
      };

      await apply("20260914144328_init");
      await apply("20260918002810_t101_auth_adapter_tables");

      // 本 migration 適用前の schema(display_name NOT NULL)に既存行を作る。
      await client.query(
        `INSERT INTO users (auth_subject, email_normalized, password_hash)
         VALUES ('credentials:upgrade@example.com', 'upgrade@example.com', 'argon2id$dummy-hash')`,
      );
      await client.query(
        `INSERT INTO user_profiles (user_id, display_name, timezone, locale, week_starts_on)
         SELECT id, '既存ユーザー', 'Asia/Tokyo', 'ja', 1 FROM users`,
      );

      await apply("20261002000000_t102_user_profile_constraints");

      const rows = await client.query(
        "SELECT display_name, timezone, locale, week_starts_on FROM user_profiles",
      );
      expect(rows.rows).toEqual([
        { display_name: "既存ユーザー", timezone: "Asia/Tokyo", locale: "ja", week_starts_on: 1 },
      ]);

      // nullable 化と CHECK の両方が効いている。
      await client.query("UPDATE user_profiles SET display_name = NULL");
      await expect(client.query("UPDATE user_profiles SET week_starts_on = 7")).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
