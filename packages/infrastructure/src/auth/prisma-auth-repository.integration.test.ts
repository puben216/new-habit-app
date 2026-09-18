import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createPrismaAuthRepository } from "./prisma-auth-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");

describe("PrismaAuthRepository(T-101 Task4)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let repository: ReturnType<typeof createPrismaAuthRepository>;

  beforeAll(async () => {
    container = await startPostgresContainer();

    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });

    prisma = createPrismaClient(container.getConnectionUri());
    repository = createPrismaAuthRepository(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it("signupでuserとverification tokenを作成し、同一emailの再signupはalready_existsを返す(AUTH-001)", async () => {
    const result = await repository.createUserWithVerificationToken({
      emailNormalized: "signup@example.com",
      passwordHash: "hash-1",
      verificationTokenHash: "token-hash-1",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(result).toBe("created");

    const duplicate = await repository.createUserWithVerificationToken({
      emailNormalized: "signup@example.com",
      passwordHash: "hash-2",
      verificationTokenHash: "token-hash-2",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(duplicate).toBe("already_exists");

    const user = await repository.findUserByEmailNormalized("signup@example.com");
    expect(user?.passwordHash).toBe("hash-1");
  });

  it("有効なtokenでconsumeVerificationTokenが成功し、emailVerifiedAtが設定される(AUTH-003)", async () => {
    await repository.createUserWithVerificationToken({
      emailNormalized: "verify@example.com",
      passwordHash: "hash",
      verificationTokenHash: "verify-token-valid",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });

    const result = await repository.consumeVerificationToken({
      tokenHash: "verify-token-valid",
      now: new Date(),
    });
    expect(result).toBe("consumed");

    const user = await repository.findUserByEmailNormalized("verify@example.com");
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it("期限切れtokenのconsumeVerificationTokenはinvalid_or_expiredを返す(AUTH-003)", async () => {
    await repository.createUserWithVerificationToken({
      emailNormalized: "expired@example.com",
      passwordHash: "hash",
      verificationTokenHash: "verify-token-expired",
      verificationTokenExpiresAt: new Date(Date.now() - 1),
    });

    const result = await repository.consumeVerificationToken({
      tokenHash: "verify-token-expired",
      now: new Date(),
    });
    expect(result).toBe("invalid_or_expired");
  });

  it("使用済みtokenの再consumeはinvalid_or_expiredを返す(単回使用)", async () => {
    await repository.createUserWithVerificationToken({
      emailNormalized: "reused@example.com",
      passwordHash: "hash",
      verificationTokenHash: "verify-token-reused",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });

    const first = await repository.consumeVerificationToken({
      tokenHash: "verify-token-reused",
      now: new Date(),
    });
    expect(first).toBe("consumed");

    const second = await repository.consumeVerificationToken({
      tokenHash: "verify-token-reused",
      now: new Date(),
    });
    expect(second).toBe("invalid_or_expired");
  });

  it("同一tokenへの並行consumeVerificationTokenは成功が1件のみになる(AUTH-INV-001)", async () => {
    await repository.createUserWithVerificationToken({
      emailNormalized: "concurrent-verify@example.com",
      passwordHash: "hash",
      verificationTokenHash: "verify-token-concurrent",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.consumeVerificationToken({
          tokenHash: "verify-token-concurrent",
          now: new Date(),
        }),
      ),
    );

    expect(results.filter((r) => r === "consumed")).toHaveLength(1);
    expect(results.filter((r) => r === "invalid_or_expired")).toHaveLength(4);
  });

  it("resendVerification相当(replaceVerificationToken)で旧tokenが無効化される(AUTH-004)", async () => {
    await repository.createUserWithVerificationToken({
      emailNormalized: "resend@example.com",
      passwordHash: "hash",
      verificationTokenHash: "verify-token-old",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    const user = await repository.findUserByEmailNormalized("resend@example.com");
    if (user === null) throw new Error("user not found");

    await repository.replaceVerificationToken({
      userId: user.id,
      tokenHash: "verify-token-new",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const oldResult = await repository.consumeVerificationToken({
      tokenHash: "verify-token-old",
      now: new Date(),
    });
    expect(oldResult).toBe("invalid_or_expired");

    const newResult = await repository.consumeVerificationToken({
      tokenHash: "verify-token-new",
      now: new Date(),
    });
    expect(newResult).toBe("consumed");
  });

  it("password reset成功後にpasswordが更新され、既存sessionがすべて失効する(AUTH-008)", async () => {
    await repository.createUserWithVerificationToken({
      emailNormalized: "reset@example.com",
      passwordHash: "old-hash",
      verificationTokenHash: "verify-token-reset-user",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    const user = await repository.findUserByEmailNormalized("reset@example.com");
    if (user === null) throw new Error("user not found");

    await prisma.session.create({
      data: {
        sessionToken: "session-to-revoke",
        userId: BigInt(user.id),
        expires: new Date(Date.now() + 60_000),
      },
    });

    await repository.createPasswordResetToken({
      userId: user.id,
      tokenHash: "reset-token-valid",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await repository.resetPasswordWithToken({
      tokenHash: "reset-token-valid",
      newPasswordHash: "new-hash",
      now: new Date(),
    });
    expect(result).toBe("consumed");

    const updatedUser = await repository.findUserByEmailNormalized("reset@example.com");
    expect(updatedUser?.passwordHash).toBe("new-hash");

    const remainingSessions = await prisma.session.count({ where: { userId: BigInt(user.id) } });
    expect(remainingSessions).toBe(0);
  });

  it("使用済みのpassword reset tokenは再利用できない(単回使用)", async () => {
    await repository.createUserWithVerificationToken({
      emailNormalized: "reset-reuse@example.com",
      passwordHash: "old-hash",
      verificationTokenHash: "verify-token-reset-reuse",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    const user = await repository.findUserByEmailNormalized("reset-reuse@example.com");
    if (user === null) throw new Error("user not found");

    await repository.createPasswordResetToken({
      userId: user.id,
      tokenHash: "reset-token-reuse",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await repository.resetPasswordWithToken({
      tokenHash: "reset-token-reuse",
      newPasswordHash: "new-hash-1",
      now: new Date(),
    });
    expect(first).toBe("consumed");

    const second = await repository.resetPasswordWithToken({
      tokenHash: "reset-token-reuse",
      newPasswordHash: "new-hash-2",
      now: new Date(),
    });
    expect(second).toBe("invalid_or_expired");
  });

  it("同一tokenへの並行resetPasswordWithTokenは成功が1件のみになる(AUTH-INV-001)", async () => {
    await repository.createUserWithVerificationToken({
      emailNormalized: "concurrent-reset@example.com",
      passwordHash: "old-hash",
      verificationTokenHash: "verify-token-concurrent-reset",
      verificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    const user = await repository.findUserByEmailNormalized("concurrent-reset@example.com");
    if (user === null) throw new Error("user not found");

    await repository.createPasswordResetToken({
      userId: user.id,
      tokenHash: "reset-token-concurrent",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repository.resetPasswordWithToken({
          tokenHash: "reset-token-concurrent",
          newPasswordHash: `new-hash-${i}`,
          now: new Date(),
        }),
      ),
    );

    expect(results.filter((r) => r === "consumed")).toHaveLength(1);
    expect(results.filter((r) => r === "invalid_or_expired")).toHaveLength(4);
  });
});
