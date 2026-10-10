import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizeAdmin,
  disableAdminUseCase,
  getUserOverviewUseCase,
  grantAdminUseCase,
  listAiJobFailuresUseCase,
  listNotificationFailuresUseCase,
  resetAdminMfaUseCase,
  searchUserByEmailUseCase,
  verifyAdminMfaUseCase,
} from "@habit-app/application";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createAdminCrypto } from "./admin-crypto";
import {
  createPrismaAdminAccountRepository,
  createPrismaAdminProvisioningRepository,
  createPrismaAdminReadRepository,
  createPrismaAuditLogRepository,
  createPrismaSessionMfaRepository,
} from "./prisma-admin-repositories";
import { base32Decode, totpAt } from "./totp";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");
const T403_MIGRATION = "20261010000000_t403_minimal_admin";
// 暗号鍵・HMAC 鍵は低エントロピーのダミー値(実際の鍵ではない)。
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const NOW = new Date("2026-10-10T03:00:00.000Z");
const CONTEXT = { requestId: "req-int-1", ipHash: "iphash" };

/** Prisma の BigInt を含む行を文字列化する(秘密が含まれないことの検証用)。 */
const stringify = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

describe("管理機能の repository 群(T-403)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  const adminRepo = () => createPrismaAdminAccountRepository(prisma);
  const sessionMfa = () => createPrismaSessionMfaRepository(prisma);
  const audit = () => createPrismaAuditLogRepository(prisma);
  const read = () => createPrismaAdminReadRepository(prisma);
  const provisioning = () => createPrismaAdminProvisioningRepository(prisma);
  const crypto = createAdminCrypto(ENCRYPTION_KEY);

  let seq = 0;
  async function createUser(label: string, options: { verified?: boolean; status?: string } = {}) {
    seq += 1;
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}-${seq}@example.test`,
        emailNormalized: `${label}-${seq}@example.test`,
        passwordHash: "hash",
        emailVerifiedAt: options.verified === false ? null : NOW,
        status: options.status ?? "active",
      },
    });
    return { id: user.id.toString(), publicId: user.publicId, email: user.emailNormalized };
  }

  async function createSession(
    userId: string,
    token: string,
    expires = new Date(NOW.getTime() + 3_600_000),
  ) {
    const session = await prisma.session.create({
      data: { sessionToken: token, userId: BigInt(userId), expires },
    });
    return session.id.toString();
  }

  const provisionDeps = () => ({
    provisioning: provisioning(),
    crypto,
    audit: audit(),
    now: () => NOW,
    requestId: "cli-int",
  });

  /** 管理者を付与し、認証アプリ相当で TOTP を計算できる関数を返す。 */
  async function grantAdmin(email: string) {
    const result = await grantAdminUseCase(provisionDeps(), { email });
    if (result.status !== "granted") throw new Error(`grant failed: ${result.status}`);
    const secret = base32Decode(new URL(result.otpauthUri).searchParams.get("secret") ?? "");
    if (secret === null) throw new Error("bad secret");
    return { ...result, totp: (at: Date = NOW) => totpAt(secret, at.getTime()) };
  }

  const verifyDeps = (now: Date = NOW) => ({
    adminRepository: adminRepo(),
    sessionMfa: sessionMfa(),
    crypto,
    audit: audit(),
    now: () => now,
  });

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
  }, 60_000);

  describe("付与・無効化・MFA 再発行(運用)", () => {
    it("確認済みユーザーを管理者にし、秘密は暗号文・コードはハッシュのみ保存する。監査は operator", async () => {
      const user = await createUser("grant");
      const granted = await grantAdmin(user.email);
      expect(granted.recoveryCodes).toHaveLength(8);

      const row = await prisma.adminUser.findUniqueOrThrow({ where: { userId: BigInt(user.id) } });
      expect(row.status).toBe("active");
      expect(row.publicId).toBe(granted.adminPublicId);
      expect(row.totpSecretEnc.startsWith("v1.")).toBe(true);
      const codes = await prisma.adminRecoveryCode.findMany({ where: { adminUserId: row.id } });
      expect(codes).toHaveLength(8);
      for (const code of granted.recoveryCodes) {
        expect(codes.some((c) => c.codeHash === crypto.hashRecoveryCode(code))).toBe(true);
        expect(codes.every((c) => c.codeHash !== code)).toBe(true);
      }
      const logs = await prisma.auditLog.findMany({ where: { targetPublicId: row.publicId } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ actor: "operator", action: "operator.admin.granted" });
      expect(stringify(logs)).not.toContain(user.email);
    });

    it("未確認・停止中・不在のユーザーは付与できず、すでに有効なら already_active", async () => {
      const unverified = await createUser("unverified", { verified: false });
      const suspended = await createUser("suspended", { status: "suspended" });
      expect(await grantAdminUseCase(provisionDeps(), { email: unverified.email })).toEqual({
        status: "user_not_eligible",
      });
      expect(await grantAdminUseCase(provisionDeps(), { email: suspended.email })).toEqual({
        status: "user_not_eligible",
      });
      expect(await grantAdminUseCase(provisionDeps(), { email: "nobody@example.test" })).toEqual({
        status: "user_not_eligible",
      });
      const user = await createUser("twice");
      await grantAdmin(user.email);
      expect(await grantAdminUseCase(provisionDeps(), { email: user.email })).toEqual({
        status: "already_active",
      });
    });

    it("無効化すると管理者として扱われず、全 session の MFA 検証が失効する。再付与で MFA が作り直される", async () => {
      const user = await createUser("disable");
      const granted = await grantAdmin(user.email);
      const sessionId = await createSession(user.id, "disable-session");
      await sessionMfa().markVerified({ sessionId, userId: user.id, now: NOW });

      expect(await disableAdminUseCase(provisionDeps(), { email: user.email })).toMatchObject({
        status: "disabled",
      });
      expect(await adminRepo().findActiveByUserId(user.id)).toBeNull();
      expect(
        (await prisma.session.findUniqueOrThrow({ where: { id: BigInt(sessionId) } }))
          .mfaVerifiedAt,
      ).toBeNull();

      const again = await grantAdmin(user.email);
      expect(again.adminPublicId).toBe(granted.adminPublicId);
      expect(again.recoveryCodes).not.toEqual(granted.recoveryCodes);
      expect(await adminRepo().findActiveByUserId(user.id)).not.toBeNull();
      // 旧リカバリーコードは使えない(置き換えられている)。
      const account = await adminRepo().findActiveByUserId(user.id);
      expect(
        await adminRepo().consumeRecoveryCode({
          adminId: account?.adminId ?? "0",
          codeHash: crypto.hashRecoveryCode(granted.recoveryCodes[0] ?? ""),
          now: NOW,
        }),
      ).toBe(false);
    });

    it("MFA の再発行は有効な管理者だけ。秘密・コードを作り直し、失敗回数・ロック・全 session の検証を解除する", async () => {
      const user = await createUser("reset");
      expect((await resetAdminMfaUseCase(provisionDeps(), { email: user.email })).status).toBe(
        "not_found",
      );
      const granted = await grantAdmin(user.email);
      const sessionId = await createSession(user.id, "reset-session");
      await sessionMfa().markVerified({ sessionId, userId: user.id, now: NOW });
      const account = await adminRepo().findActiveByUserId(user.id);
      for (let i = 0; i < 5; i += 1) {
        await adminRepo().recordMfaFailure({
          adminId: account?.adminId ?? "0",
          now: NOW,
          maxAttempts: 5,
          lockoutMs: 900_000,
        });
      }

      const reset = await resetAdminMfaUseCase(provisionDeps(), { email: user.email });
      expect(reset.status).toBe("reset");
      if (reset.status !== "reset") return;
      expect(reset.recoveryCodes).not.toEqual(granted.recoveryCodes);
      const after = await adminRepo().findActiveByUserId(user.id);
      expect(after).toMatchObject({ failedAttempts: 0, lockedUntil: null, totpLastStep: null });
      expect(
        (await prisma.session.findUniqueOrThrow({ where: { id: BigInt(sessionId) } }))
          .mfaVerifiedAt,
      ).toBeNull();
    });
  });

  describe("MFA 検証(実 DB + 実 TOTP)", () => {
    it("TOTP で session が検証済みになり、30 分以内は granted、30 分で mfa_required。別 session は引き継がない", async () => {
      const user = await createUser("mfa");
      const granted = await grantAdmin(user.email);
      const sessionA = await createSession(user.id, "mfa-a");
      const sessionB = await createSession(user.id, "mfa-b");

      expect(
        await verifyAdminMfaUseCase(verifyDeps(), {
          actorUserId: user.id,
          sessionId: sessionA,
          code: granted.totp(),
          context: CONTEXT,
        }),
      ).toEqual({ status: "verified" });

      const verifiedAt = (
        await prisma.session.findUniqueOrThrow({ where: { id: BigInt(sessionA) } })
      ).mfaVerifiedAt;
      const authorize = (mfaVerifiedAt: Date | null, now: Date) =>
        authorizeAdmin(
          { adminRepository: adminRepo(), now: () => now },
          { actorUserId: user.id, mfaVerifiedAt },
        );
      expect((await authorize(verifiedAt, new Date(NOW.getTime() + 29 * 60_000))).status).toBe(
        "granted",
      );
      expect((await authorize(verifiedAt, new Date(NOW.getTime() + 30 * 60_000))).status).toBe(
        "mfa_required",
      );
      const otherVerified = (
        await prisma.session.findUniqueOrThrow({ where: { id: BigInt(sessionB) } })
      ).mfaVerifiedAt;
      expect(otherVerified).toBeNull();
      expect((await authorize(otherVerified, NOW)).status).toBe("mfa_required");

      const logs = await prisma.auditLog.findMany({
        where: { actor: `admin:${granted.adminPublicId}` },
      });
      expect(logs.map((l) => l.action)).toEqual(["admin.mfa.verified"]);
      expect(stringify(logs)).not.toContain(granted.totp());
    });

    it("同じ TOTP の再利用(replay)は拒否され、並行 4 件でも成功は 1 件だけ", async () => {
      const user = await createUser("replay");
      const granted = await grantAdmin(user.email);
      // 失敗の累積でロックされない件数(上限 5 回未満)で並行させ、成功がちょうど 1 件であることを決定的に確認する。
      const sessions = await Promise.all(
        [1, 2, 3, 4].map((n) => createSession(user.id, `replay-${n}`)),
      );
      const results = await Promise.all(
        sessions.map((sessionId) =>
          verifyAdminMfaUseCase(verifyDeps(), {
            actorUserId: user.id,
            sessionId,
            code: granted.totp(),
            context: CONTEXT,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "verified")).toHaveLength(1);
      const verified = await prisma.session.count({
        where: { userId: BigInt(user.id), mfaVerifiedAt: { not: null } },
      });
      expect(verified).toBe(1);
    });

    it("連続 5 回の失敗でロックされ、ロック中は正しいコードも拒否。ロック明けは受理され失敗回数が戻る", async () => {
      const user = await createUser("lock");
      const granted = await grantAdmin(user.email);
      const sessionId = await createSession(user.id, "lock-session");
      const run = (code: string, now: Date = NOW) =>
        verifyAdminMfaUseCase(verifyDeps(now), {
          actorUserId: user.id,
          sessionId,
          code,
          context: CONTEXT,
        });

      for (let i = 0; i < 4; i += 1) expect((await run("000000")).status).toBe("invalid");
      expect(await run("000000")).toMatchObject({ status: "locked", retryAfterSeconds: 900 });
      expect(await run(granted.totp())).toMatchObject({ status: "locked" });
      expect(
        (await prisma.session.findUniqueOrThrow({ where: { id: BigInt(sessionId) } }))
          .mfaVerifiedAt,
      ).toBeNull();

      const later = new Date(NOW.getTime() + 15 * 60_000);
      expect(await run(granted.totp(later), later)).toEqual({ status: "verified" });
      expect(await adminRepo().findActiveByUserId(user.id)).toMatchObject({
        failedAttempts: 0,
        lockedUntil: null,
      });
      const actions = (
        await prisma.auditLog.findMany({
          where: { actor: `admin:${granted.adminPublicId}` },
          orderBy: { id: "asc" },
        })
      ).map((l) => l.action);
      expect(actions).toContain("admin.mfa.locked");
      expect(actions.filter((a) => a === "admin.mfa.failed")).toHaveLength(5);
    });

    it("同時の失敗でも失敗回数が失われない(原子的な加算)", async () => {
      const user = await createUser("atomic");
      await grantAdmin(user.email);
      const account = await adminRepo().findActiveByUserId(user.id);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          adminRepo().recordMfaFailure({
            adminId: account?.adminId ?? "0",
            now: NOW,
            maxAttempts: 5,
            lockoutMs: 900_000,
          }),
        ),
      );
      expect(results.every((r) => r.locked || r.lockedUntil === null)).toBe(true);
      const after = await adminRepo().findActiveByUserId(user.id);
      expect(after?.failedAttempts).toBe(10);
      expect(after?.lockedUntil).not.toBeNull();
    });

    it("リカバリーコードは一度だけ(並行 3 件でも 1 回)、別の管理者のコードは使えない。使用は監査に残る", async () => {
      const user = await createUser("recovery");
      const other = await createUser("recovery-other");
      const granted = await grantAdmin(user.email);
      const otherGranted = await grantAdmin(other.email);

      // 別の管理者のコードは使えない(失敗 1 回)。
      const crossSession = await createSession(user.id, "rec-cross");
      expect(
        (
          await verifyAdminMfaUseCase(verifyDeps(), {
            actorUserId: user.id,
            sessionId: crossSession,
            code: otherGranted.recoveryCodes[0],
            context: CONTEXT,
          })
        ).status,
      ).toBe("invalid");

      // 同じコードの並行使用。失敗の累積でロックされない件数(上限 5 回未満)で、成功がちょうど 1 件であることを確認する。
      const sessions = await Promise.all([1, 2, 3].map((n) => createSession(user.id, `rec-${n}`)));
      const code = granted.recoveryCodes[0] ?? "";
      const results = await Promise.all(
        sessions.map((sessionId) =>
          verifyAdminMfaUseCase(verifyDeps(), {
            actorUserId: user.id,
            sessionId,
            code: code.toLowerCase().replace("-", " "),
            context: CONTEXT,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "verified")).toHaveLength(1);

      const actions = (
        await prisma.auditLog.findMany({ where: { actor: `admin:${granted.adminPublicId}` } })
      ).map((l) => l.action);
      expect(actions).toContain("admin.mfa.recovery_used");
    });

    it("失効済み・不在の session は検証済みにならない。管理者でないユーザーは not_admin", async () => {
      const user = await createUser("expired-session");
      const granted = await grantAdmin(user.email);
      const expired = await createSession(user.id, "expired", new Date(NOW.getTime() - 1000));
      expect(
        (
          await verifyAdminMfaUseCase(verifyDeps(), {
            actorUserId: user.id,
            sessionId: expired,
            code: granted.totp(),
            context: CONTEXT,
          })
        ).status,
      ).toBe("invalid");
      expect(
        (
          await verifyAdminMfaUseCase(verifyDeps(), {
            actorUserId: user.id,
            sessionId: "999999",
            code: granted.totp(new Date(NOW.getTime() + 30_000)),
            context: CONTEXT,
          })
        ).status,
      ).toBe("invalid");
      const member = await createUser("member");
      expect(
        (
          await verifyAdminMfaUseCase(verifyDeps(), {
            actorUserId: member.id,
            sessionId: "1",
            code: "123456",
            context: CONTEXT,
          })
        ).status,
      ).toBe("not_admin");
    });

    it("他のユーザーの session ID が渡されても検証済みにならない(actor の session だけを更新する)", async () => {
      const admin = await createUser("session-owner-admin");
      const victim = await createUser("session-owner-victim");
      const granted = await grantAdmin(admin.email);
      const victimSession = await createSession(victim.id, "victim-session");

      expect(
        await verifyAdminMfaUseCase(verifyDeps(), {
          actorUserId: admin.id,
          sessionId: victimSession,
          code: granted.totp(),
          context: CONTEXT,
        }),
      ).toEqual({ status: "invalid" });
      const row = await prisma.session.findUniqueOrThrow({ where: { id: BigInt(victimSession) } });
      expect(row.mfaVerifiedAt).toBeNull();
      // clearVerified も他人の session を変更しない。
      const own = await createSession(admin.id, "own-session");
      await sessionMfa().markVerified({ sessionId: own, userId: admin.id, now: NOW });
      await sessionMfa().clearVerified({ sessionId: own, userId: victim.id });
      expect(
        (await prisma.session.findUniqueOrThrow({ where: { id: BigInt(own) } })).mfaVerifiedAt,
      ).not.toBeNull();
    });

    it("停止中のユーザーは管理者として扱われない", async () => {
      const user = await createUser("suspend-admin");
      await grantAdmin(user.email);
      expect(await adminRepo().findActiveByUserId(user.id)).not.toBeNull();
      await prisma.$executeRaw`UPDATE users SET status = 'suspended' WHERE id = ${BigInt(user.id)}`;
      expect(await adminRepo().findActiveByUserId(user.id)).toBeNull();
    });
  });

  describe("監査ログ(追記専用)", () => {
    it("追記でき、UPDATE / DELETE / TRUNCATE は DB が拒否する", async () => {
      await audit().append({
        actor: "admin:test",
        action: "admin.user.view",
        targetType: "user",
        targetPublicId: "3f2b8c1e-5a47-4d9e-8c36-1b2a9e7d4f10",
        requestId: "req-audit",
        ipHash: "h",
        now: NOW,
      });
      const row = await prisma.auditLog.findFirstOrThrow({ where: { requestId: "req-audit" } });
      await expect(
        prisma.$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE id = ${row.id}`,
      ).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${row.id}`).rejects.toThrow(
        /append-only/,
      );
      await expect(prisma.$executeRaw`TRUNCATE audit_logs`).rejects.toThrow(/append-only/);
      expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).action).toBe(
        "admin.user.view",
      );
    });

    it("空の actor/action、uuid でない対象は拒否される(失敗は例外 = 閲覧しない)", async () => {
      const base = {
        targetType: "user",
        targetPublicId: null,
        requestId: "r",
        ipHash: "h",
        now: NOW,
      };
      await expect(audit().append({ ...base, actor: "", action: "a" })).rejects.toThrow();
      await expect(audit().append({ ...base, actor: "a", action: "" })).rejects.toThrow();
      await expect(
        audit().append({ ...base, actor: "a", action: "a", targetPublicId: "not-a-uuid" }),
      ).rejects.toThrow("uuid");
    });
  });

  describe("閲覧(検索・概要・失敗一覧)", () => {
    const admin = { adminId: "1", adminPublicId: "3f2b8c1e-5a47-4d9e-8c36-1b2a9e7d4f10" };
    const readDeps = () => ({ read: read(), audit: audit(), now: () => NOW });

    it("検索は email の完全一致(大文字小文字を無視)のみ。マスクされ、検索した email は監査に残らない", async () => {
      const user = await createUser("search");
      const items = await searchUserByEmailUseCase(readDeps(), {
        admin,
        context: CONTEXT,
        email: user.email.toUpperCase(),
      });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ publicId: user.publicId, status: "active" });
      expect(items[0]?.emailMasked).toBe(`s***@example.test`);
      expect(JSON.stringify(items)).not.toContain(user.email);

      for (const partial of ["search", "@example.test", user.email.slice(0, -2)]) {
        expect(
          await searchUserByEmailUseCase(readDeps(), { admin, context: CONTEXT, email: partial }),
        ).toEqual([]);
      }
      const logs = await prisma.auditLog.findMany({ where: { action: "admin.user.search" } });
      expect(logs.length).toBeGreaterThanOrEqual(4);
      expect(stringify(logs)).not.toContain("example.test");
    });

    async function insertDelivery(
      userId: string,
      status: string,
      failureCode: string | null,
      createdAt: Date = NOW,
    ) {
      const setting = await prisma.$queryRaw<{ id: bigint }[]>`
        INSERT INTO notification_settings (user_id, local_time, timezone, enabled)
        VALUES (${BigInt(userId)}, '08:00'::time, 'Asia/Tokyo', true)
        ON CONFLICT (user_id) WHERE habit_id IS NULL DO UPDATE SET enabled = true
        RETURNING id`;
      const settingId = setting[0]?.id ?? 0n;
      seq += 1;
      await prisma.$executeRaw`
        INSERT INTO notification_deliveries
          (notification_setting_id, user_id, local_date, scheduled_at, deduplication_key, status,
           attempt_count, next_attempt_at, failure_code, created_at)
        VALUES (${settingId}, ${BigInt(userId)}, '2026-10-09'::date, ${NOW}, ${`admin-test:${seq}`},
                ${status}, 1, ${NOW}, ${failureCode}, ${createdAt})`;
    }

    it("概要は状態別の件数・suppression・emailVerified だけを返し、存在しない公開 ID は null", async () => {
      const user = await createUser("overview");
      await insertDelivery(user.id, "failed", "rejected");
      await insertDelivery(user.id, "sent", null);
      await insertDelivery(user.id, "sent", null);
      // 集計期間(直近 30 日)より前の配送は数えない。
      await insertDelivery(
        user.id,
        "failed",
        "rejected",
        new Date(NOW.getTime() - 31 * 86_400_000),
      );
      await prisma.$executeRaw`INSERT INTO email_suppressions (user_id, reason) VALUES (${BigInt(user.id)}, 'bounce')`;
      const other = await createUser("overview-other");
      await insertDelivery(other.id, "failed", "timeout");

      const overview = await getUserOverviewUseCase(readDeps(), {
        admin,
        context: CONTEXT,
        publicId: user.publicId,
      });
      expect(overview).toMatchObject({
        publicId: user.publicId,
        emailVerified: true,
        notification: { suppressed: true, deliveries: { failed: 1, sent: 2 } },
        aiJobs: {},
      });
      expect(Object.keys(overview ?? {}).sort()).toEqual([
        "aiJobs",
        "createdAt",
        "emailMasked",
        "emailVerified",
        "notification",
        "publicId",
        "status",
      ]);
      expect(
        await getUserOverviewUseCase(readDeps(), {
          admin,
          context: CONTEXT,
          publicId: "00000000-0000-4000-8000-000000000000",
        }),
      ).toBeNull();
    });

    it("通知の失敗一覧は新しい順の keyset で、状態を絞り込め、email・設定の中身を含まない", async () => {
      const user = await createUser("failures");
      for (const status of ["failed", "expired", "suppressed", "sent", "skipped", "failed"]) {
        await insertDelivery(user.id, status, status === "failed" ? "rejected" : null);
      }
      const all = await listNotificationFailuresUseCase(readDeps(), {
        admin,
        context: CONTEXT,
        limit: 100,
      });
      const mine = all.items.filter((i) => i.userPublicId === user.publicId);
      expect(mine.map((i) => i.status)).toEqual(["failed", "suppressed", "expired", "failed"]);
      for (const item of mine) {
        expect(Object.keys(item).sort()).toEqual([
          "attemptCount",
          "failureCode",
          "id",
          "localDate",
          "scheduledAt",
          "status",
          "updatedAt",
          "userPublicId",
        ]);
      }

      const page1 = await listNotificationFailuresUseCase(readDeps(), {
        admin,
        context: CONTEXT,
        limit: 2,
      });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await listNotificationFailuresUseCase(readDeps(), {
        admin,
        context: CONTEXT,
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(BigInt(page2.items[0]?.id ?? "0")).toBeLessThan(BigInt(page1.items[1]?.id ?? "0"));

      const onlyExpired = await listNotificationFailuresUseCase(readDeps(), {
        admin,
        context: CONTEXT,
        statuses: ["expired"],
        limit: 100,
      });
      expect(onlyExpired.items.every((i) => i.status === "expired")).toBe(true);
      // 不正な cursor は空(例外にしない)。
      expect(
        (
          await listNotificationFailuresUseCase(readDeps(), {
            admin,
            context: CONTEXT,
            cursor: "abc",
          })
        ).items,
      ).toEqual([]);
    });

    it("AI ジョブの失敗一覧は failed/fallback のメタデータのみ(結果本文・入力の指紋を含まない)", async () => {
      const user = await createUser("aijobs");
      for (const status of ["failed", "fallback", "succeeded", "queued"]) {
        seq += 1;
        await prisma.$executeRaw`
          INSERT INTO ai_jobs (user_id, kind, subject_type, subject_public_id, status, prompt_version,
                               output_schema_version, provider, model, input_fingerprint, result_json, failure_code)
          VALUES (${BigInt(user.id)}, 'habit_design', 'habit', gen_random_uuid(), ${status}, 'v1', 'v1',
                  'fake', 'fake-1', ${`fp-secret-${seq}`},
                  ${status === "fallback" || status === "succeeded" ? '{"note":"model output secret"}' : null}::jsonb,
                  ${status === "failed" ? "timeout" : null})`;
      }
      const page = await listAiJobFailuresUseCase(readDeps(), {
        admin,
        context: CONTEXT,
        limit: 100,
      });
      const mine = page.items.filter((i) => i.userPublicId === user.publicId);
      expect(mine.map((i) => i.status).sort()).toEqual(["failed", "fallback"]);
      expect(Object.keys(mine[0] ?? {}).sort()).toEqual([
        "createdAt",
        "failureCode",
        "kind",
        "model",
        "promptVersion",
        "provider",
        "publicId",
        "status",
        "userPublicId",
      ]);
      expect(JSON.stringify(page)).not.toMatch(/model output secret|fp-secret/);
    });

    it("各閲覧は監査を残す。監査の追記が失敗する状況(不正な対象)では閲覧しない", async () => {
      const before = await prisma.auditLog.count({ where: { action: "admin.notifications.list" } });
      await listNotificationFailuresUseCase(readDeps(), { admin, context: CONTEXT });
      expect(await prisma.auditLog.count({ where: { action: "admin.notifications.list" } })).toBe(
        before + 1,
      );

      await expect(
        getUserOverviewUseCase(readDeps(), { admin, context: CONTEXT, publicId: "not-a-uuid" }),
      ).rejects.toThrow("uuid");
    });
  });

  describe("運用スクリプト(tsx で実際に実行)", () => {
    const repoRoot = path.resolve(infrastructureRoot, "../..");
    const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
    const script = path.join(infrastructureRoot, "src", "admin", "admin-cli-main.ts");

    function runCli(args: string[], extraEnv: Record<string, string> = {}) {
      try {
        const stdout = execFileSync(tsx, [script, ...args], {
          cwd: repoRoot,
          env: {
            ...process.env,
            DATABASE_URL: container.getConnectionUri(),
            ADMIN_TOTP_ENCRYPTION_KEY: ENCRYPTION_KEY,
            ...extraEnv,
          },
          stdio: ["ignore", "pipe", "pipe"],
        }).toString();
        return { code: 0, stdout, stderr: "" };
      } catch (error) {
        const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
        return {
          code: e.status ?? 1,
          stdout: e.stdout?.toString() ?? "",
          stderr: e.stderr?.toString() ?? "",
        };
      }
    }

    it("grant → 表示された URI で TOTP を計算して MFA を通せる。disable で 404 扱い。出力に email を含まない", async () => {
      const user = await createUser("cli");
      const granted = runCli(["grant", "--email", user.email]);
      expect(granted.code).toBe(0);
      expect(granted.stdout).not.toContain(user.email);

      const uri = granted.stdout.split("\n").find((line) => line.startsWith("otpauth://")) ?? "";
      const secret = base32Decode(new URL(uri).searchParams.get("secret") ?? "");
      expect(secret).not.toBeNull();
      const recovery = granted.stdout.match(/[A-Z2-9]{5}-[A-Z2-9]{5}/g) ?? [];
      expect(recovery).toHaveLength(8);

      const sessionId = await createSession(user.id, "cli-session");
      const now = new Date();
      expect(
        await verifyAdminMfaUseCase(verifyDeps(now), {
          actorUserId: user.id,
          sessionId,
          code: totpAt(secret as Buffer, now.getTime()),
          context: CONTEXT,
        }),
      ).toEqual({ status: "verified" });

      expect(runCli(["grant", "--email", user.email]).code).toBe(1);
      expect(runCli(["disable", "--email", user.email]).code).toBe(0);
      expect(await adminRepo().findActiveByUserId(user.id)).toBeNull();
      const operatorLogs = await prisma.auditLog.findMany({ where: { actor: "operator" } });
      expect(operatorLogs.map((l) => l.action)).toEqual(
        expect.arrayContaining(["operator.admin.granted", "operator.admin.disabled"]),
      );
    }, 60_000);

    it("引数不正は終了コード 2、設定不足は終了コード 2 で秘密を出力しない", () => {
      expect(runCli(["grant"]).code).toBe(2);
      const missing = runCli(["grant", "--email", "a@example.test"], {
        ADMIN_TOTP_ENCRYPTION_KEY: "",
      });
      expect(missing.code).not.toBe(0);
      expect(missing.stdout).not.toContain("otpauth://");
    }, 60_000);
  });

  describe("DB 制約", () => {
    it("CHECK(status、失敗回数)、UNIQUE(user_id、code_hash)、CASCADE", async () => {
      const user = await createUser("constraints");
      await grantAdmin(user.email);
      await expect(
        prisma.$executeRaw`UPDATE admin_users SET status = 'root' WHERE user_id = ${BigInt(user.id)}`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE admin_users SET mfa_failed_attempts = -1 WHERE user_id = ${BigInt(user.id)}`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`INSERT INTO admin_users (user_id, totp_secret_enc) VALUES (${BigInt(user.id)}, 'x')`,
      ).rejects.toThrow();
      const account = await prisma.adminUser.findUniqueOrThrow({
        where: { userId: BigInt(user.id) },
      });
      const code = await prisma.adminRecoveryCode.findFirstOrThrow({
        where: { adminUserId: account.id },
      });
      await expect(
        prisma.$executeRaw`INSERT INTO admin_recovery_codes (admin_user_id, code_hash) VALUES (${account.id}, ${code.codeHash})`,
      ).rejects.toThrow();

      await prisma.user.delete({ where: { id: BigInt(user.id) } });
      expect(await prisma.adminUser.count({ where: { id: account.id } })).toBe(0);
      expect(await prisma.adminRecoveryCode.count({ where: { adminUserId: account.id } })).toBe(0);
    });
  });
});

describe("Migration t403 の upgrade(直前の Migration まで適用済みの DB から)", () => {
  it("既存の session・audit_logs を保ったまま適用でき、適用後に追記専用になる", async () => {
    const upgradeContainer = await startPostgresContainer();
    try {
      const migrationsDir = path.join(infrastructureRoot, "database", "migrations");
      const names = fs
        .readdirSync(migrationsDir)
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
      expect(names).toContain(T403_MIGRATION);

      const env = { ...process.env, DATABASE_URL: upgradeContainer.getConnectionUri() };
      const staging = fs.mkdtempSync(path.join(infrastructureRoot, ".t403-upgrade-"));
      const stagingConfig = path.join(infrastructureRoot, ".t403-upgrade.config.ts");
      try {
        fs.copyFileSync(
          path.join(migrationsDir, "migration_lock.toml"),
          path.join(staging, "migration_lock.toml"),
        );
        for (const name of names.filter((n) => n < T403_MIGRATION)) {
          fs.cpSync(path.join(migrationsDir, name), path.join(staging, name), { recursive: true });
        }
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

      const client = createPrismaClient(upgradeContainer.getConnectionUri());
      try {
        const user = await client.user.create({
          data: {
            authSubject: "credentials:upgrade-admin@example.test",
            emailNormalized: "upgrade-admin@example.test",
            passwordHash: "hash",
          },
        });
        await client.$executeRaw`
          INSERT INTO sessions (session_token, user_id, expires)
          VALUES ('upgrade-session', ${user.id}, now() + interval '1 hour')`;
        await client.$executeRaw`
          INSERT INTO audit_logs (actor, action, target_type, request_id, ip_hash)
          VALUES ('system', 'legacy.event', 'x', 'req-legacy', 'h')`;

        execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
          cwd: infrastructureRoot,
          env,
          stdio: "pipe",
        });

        const session = await client.session.findUniqueOrThrow({
          where: { sessionToken: "upgrade-session" },
        });
        expect(session.mfaVerifiedAt).toBeNull();
        expect(await client.auditLog.count({ where: { requestId: "req-legacy" } })).toBe(1);
        await expect(
          client.$executeRaw`DELETE FROM audit_logs WHERE request_id = 'req-legacy'`,
        ).rejects.toThrow(/append-only/);
        const indexes = await client.$queryRaw<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes
          WHERE indexname IN ('admin_users_user_id_key', 'admin_users_public_id_key',
                              'admin_recovery_codes_code_hash_key', 'admin_recovery_codes_admin_user_id_idx',
                              'audit_logs_actor_created_at_idx', 'audit_logs_created_at_idx')`;
        expect(indexes).toHaveLength(6);
      } finally {
        await client.$disconnect();
      }
    } finally {
      await upgradeContainer.stop();
    }
  }, 180_000);
});
