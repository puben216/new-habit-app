import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createPrismaLoginAttemptRepository } from "./prisma-login-attempt-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");

describe("PrismaLoginAttemptRepository(T-101 Task4)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await startPostgresContainer();

    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });

    prisma = createPrismaClient(container.getConnectionUri());
  }, 120_000);

  afterEach(async () => {
    await prisma.loginAttempt.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it("失敗回数が閾値未満の間はisBlockedがfalseを返す(AUTH-010)", async () => {
    const repository = createPrismaLoginAttemptRepository(prisma, {
      windowMs: 60_000,
      maxAttempts: 5,
    });

    for (let i = 0; i < 4; i += 1) {
      await repository.record("login", "blocked@example.com", false);
    }

    await expect(repository.isBlocked("login", "blocked@example.com")).resolves.toBe(false);
  });

  it("失敗回数が閾値に達するとisBlockedがtrueを返す(AUTH-010)", async () => {
    const repository = createPrismaLoginAttemptRepository(prisma, {
      windowMs: 60_000,
      maxAttempts: 5,
    });

    for (let i = 0; i < 5; i += 1) {
      await repository.record("login", "blocked2@example.com", false);
    }

    await expect(repository.isBlocked("login", "blocked2@example.com")).resolves.toBe(true);
  });

  it("成功した試行はisBlockedの失敗カウントに含まれない", async () => {
    const repository = createPrismaLoginAttemptRepository(prisma, {
      windowMs: 60_000,
      maxAttempts: 5,
    });

    for (let i = 0; i < 5; i += 1) {
      await repository.record("login", "mixed@example.com", true);
    }

    await expect(repository.isBlocked("login", "mixed@example.com")).resolves.toBe(false);
  });

  it("purposeが異なる試行は互いにカウントされない", async () => {
    const repository = createPrismaLoginAttemptRepository(prisma, {
      windowMs: 60_000,
      maxAttempts: 5,
    });

    for (let i = 0; i < 5; i += 1) {
      await repository.record("signup", "purpose@example.com", false);
    }

    await expect(repository.isBlocked("login", "purpose@example.com")).resolves.toBe(false);
    await expect(repository.isBlocked("signup", "purpose@example.com")).resolves.toBe(true);
  });

  it("pruneExpiredは判定ウィンドウを超えた履歴を削除する(retention)", async () => {
    const repository = createPrismaLoginAttemptRepository(prisma, {
      windowMs: 1_000,
      maxAttempts: 5,
    });

    await prisma.loginAttempt.create({
      data: {
        purpose: "login",
        emailNormalized: "stale@example.com",
        succeeded: false,
        attemptedAt: new Date(Date.now() - 60_000),
      },
    });
    await repository.record("login", "fresh@example.com", false);

    await repository.pruneExpired();

    const remaining = await prisma.loginAttempt.findMany();
    expect(remaining.some((r) => r.emailNormalized === "stale@example.com")).toBe(false);
    expect(remaining.some((r) => r.emailNormalized === "fresh@example.com")).toBe(true);
  });
});
