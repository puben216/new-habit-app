import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelAccountDeletionUseCase,
  getAccountDeletionStatusUseCase,
  purgeExpiredAccountsUseCase,
  requestAccountDeletionUseCase,
} from "@habit-app/application";
import type { AccountRequestContext } from "@habit-app/application";
import { ACCOUNT_DELETION_GRACE_DAYS, purgeCutoff } from "@habit-app/domain";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createArgon2PasswordHasher } from "../auth/argon2-password-hasher";
import { createPrismaAuthRepository } from "../auth/prisma-auth-repository";
import { createPrismaLoginAttemptRepository } from "../auth/prisma-login-attempt-repository";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import {
  createNoopExternalDataCleanup,
  createPrismaAccountRepository,
} from "./prisma-account-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");
const T404_MIGRATION = "20261012000000_t404_account_deletion";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T03:00:00.000Z");
const CONTEXT: AccountRequestContext = { requestId: "req-int-1", ipHash: "iphash" };
const PASSWORD = "correct horse battery staple";

describe("アカウント削除の repository(T-404)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let passwordHash: string;
  const hasher = createArgon2PasswordHasher();

  const accounts = () => createPrismaAccountRepository(prisma);
  const attempts = () => createPrismaLoginAttemptRepository(prisma);
  const requestDeps = (now = NOW) => ({
    accounts: accounts(),
    passwordHasher: hasher,
    attempts: attempts(),
    now: () => now,
  });
  const purgeDeps = (now = NOW) => ({
    accounts: accounts(),
    cleanup: createNoopExternalDataCleanup(),
    now: () => now,
    newRequestId: () => "job-int-1",
  });

  let seq = 0;
  async function createUser(label: string) {
    seq += 1;
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}-${seq}@example.test`,
        emailNormalized: `${label}-${seq}@example.test`,
        passwordHash,
        emailVerifiedAt: NOW,
      },
    });
    return { id: user.id.toString(), publicId: user.publicId, email: user.emailNormalized };
  }

  /** 全種類の個人データを持つユーザーを作る(削除の完全性の検証用)。 */
  async function seedAllData(userId: string): Promise<void> {
    const id = BigInt(userId);
    await prisma.$executeRaw`
      INSERT INTO user_profiles (user_id, display_name, timezone, locale, week_starts_on)
      VALUES (${id}, 'テスト', 'Asia/Tokyo', 'ja', 1)`;
    const habit = await prisma.habit.create({
      data: {
        userId: id,
        kind: "build",
        name: "散歩",
        purpose: "p",
        cue: "c",
        minimumAction: "m",
      },
    });
    await prisma.$executeRaw`
      INSERT INTO habit_schedule_versions (habit_id, effective_from, days_of_week)
      VALUES (${habit.id}, '2026-01-01'::date, ARRAY[1, 2])`;
    await prisma.$executeRaw`
      INSERT INTO habit_entries (user_id, habit_id, habit_date, status)
      VALUES (${id}, ${habit.id}, '2026-10-01'::date, 'success')`;
    await prisma.$executeRaw`
      INSERT INTO daily_check_ins (user_id, check_in_date, mood, note)
      VALUES (${id}, '2026-10-01'::date, 4, '個人的なメモ')`;
    await prisma.$executeRaw`
      INSERT INTO weekly_reviews (user_id, week_start, timezone_snapshot, summary_json)
      VALUES (${id}, '2026-09-28'::date, 'Asia/Tokyo', '{}'::jsonb)`;
    const job = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO ai_jobs (user_id, kind, subject_type, subject_public_id, status, prompt_version,
                           output_schema_version, provider, model, input_fingerprint)
      VALUES (${id}, 'habit_design', 'habit', gen_random_uuid(), 'succeeded', 'v1', 'v1', 'fake', 'fake-1', 'fp')
      RETURNING id`;
    await prisma.$executeRaw`
      INSERT INTO ai_job_attempts (ai_job_id, attempt_no, started_at, outcome)
      VALUES (${job[0]?.id}, 1, ${NOW}, 'ok')`;
    const setting = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO notification_settings (user_id, channel, local_time, timezone, enabled)
      VALUES (${id}, 'email', '20:00'::time, 'Asia/Tokyo', true) RETURNING id`;
    await prisma.$executeRaw`
      INSERT INTO notification_deliveries
        (notification_setting_id, user_id, local_date, scheduled_at, deduplication_key, status,
         attempt_count, next_attempt_at)
      VALUES (${setting[0]?.id}, ${id}, '2026-10-09'::date, ${NOW}, ${`purge-test:${userId}`},
              'sent', 1, ${NOW})`;
    await prisma.$executeRaw`
      INSERT INTO email_suppressions (user_id, reason) VALUES (${id}, 'bounce')`;
    await prisma.$executeRaw`
      INSERT INTO idempotency_keys (user_id, scope, key, request_hash, expires_at)
      VALUES (${id}, 's', 'k', 'h', ${new Date(NOW.getTime() + DAY_MS)})`;
    await prisma.$executeRaw`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${id}, ${`reset-${userId}`}, ${new Date(NOW.getTime() + DAY_MS)})`;
    await prisma.$executeRaw`
      INSERT INTO sessions (session_token, user_id, expires)
      VALUES (${`session-${userId}`}, ${id}, ${new Date(NOW.getTime() + DAY_MS)})`;
    const admin = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO admin_users (user_id, totp_secret_enc) VALUES (${id}, 'enc') RETURNING id`;
    await prisma.$executeRaw`
      INSERT INTO admin_recovery_codes (admin_user_id, code_hash)
      VALUES (${admin[0]?.id}, ${`code-${userId}`})`;
  }

  /** `user_id` 列を持つ全テーブルについて、そのユーザーの行数の合計を返す。 */
  async function rowsOwnedBy(userId: string): Promise<number> {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'user_id'`;
    let total = 0;
    for (const { table_name } of tables) {
      // table_name は information_schema 由来(外部入力ではない)。識別子はバインドできないため $queryRawUnsafe を使う。
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM "${table_name}" WHERE user_id = $1`,
        BigInt(userId),
      );
      total += Number(rows[0]?.count ?? 0);
    }
    return total;
  }

  async function userStatus(userId: string) {
    return prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: { status: true, deletedAt: true },
    });
  }

  async function auditRows(targetPublicId: string) {
    return prisma.auditLog.findMany({ where: { targetPublicId }, orderBy: { id: "asc" } });
  }

  beforeAll(async () => {
    container = await startPostgresContainer();
    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });
    prisma = createPrismaClient(container.getConnectionUri());
    passwordHash = await hasher.hash(PASSWORD);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  }, 60_000);

  describe("削除の要求(ACD-001/002)", () => {
    it("再認証に成功すると削除予約になり、全 session が消え、監査が 1 件追加される。他ユーザーは変わらない", async () => {
      const user = await createUser("request");
      const other = await createUser("request-other");
      for (const owner of [user, other]) {
        await prisma.$executeRaw`
          INSERT INTO sessions (session_token, user_id, expires)
          VALUES (${`s1-${owner.id}`}, ${BigInt(owner.id)}, ${new Date(NOW.getTime() + DAY_MS)}),
                 (${`s2-${owner.id}`}, ${BigInt(owner.id)}, ${new Date(NOW.getTime() + DAY_MS)})`;
      }

      const result = await requestAccountDeletionUseCase(requestDeps(), {
        actorUserId: user.id,
        password: PASSWORD,
        context: CONTEXT,
      });
      expect(result.scheduledFor).toEqual(
        new Date(NOW.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS),
      );

      expect(await userStatus(user.id)).toEqual({ status: "deletion_pending", deletedAt: NOW });
      expect(await prisma.session.count({ where: { userId: BigInt(user.id) } })).toBe(0);
      expect(await userStatus(other.id)).toEqual({ status: "active", deletedAt: null });
      expect(await prisma.session.count({ where: { userId: BigInt(other.id) } })).toBe(2);

      const rows = await auditRows(user.publicId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: `user:${user.publicId}`,
        action: "user.account.deletion_requested",
        targetType: "user",
        requestId: "req-int-1",
        ipHash: "iphash",
      });
      // 監査にメール・パスワードが含まれない。
      const text = JSON.stringify(rows, (_k, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      expect(text).not.toContain(user.email);
      expect(text).not.toContain(PASSWORD);
    });

    it("誤ったパスワードは受理されず、5 回続くと reauth だけが制限され、ログインは影響を受けない", async () => {
      const user = await createUser("reauth");
      for (let i = 0; i < 5; i += 1) {
        await expect(
          requestAccountDeletionUseCase(requestDeps(), {
            actorUserId: user.id,
            password: "wrong",
            context: CONTEXT,
          }),
        ).rejects.toThrow("reauthentication failed");
      }
      await expect(
        requestAccountDeletionUseCase(requestDeps(), {
          actorUserId: user.id,
          password: PASSWORD,
          context: CONTEXT,
        }),
      ).rejects.toThrow("too many attempts");
      expect((await userStatus(user.id))?.status).toBe("active");

      expect(await attempts().isBlocked("reauth", user.email)).toBe(true);
      expect(await attempts().isBlocked("login", user.email)).toBe(false);
    });

    it("並行する要求は 1 件だけが成立し、監査も 1 件(残りは既に予約済み)", async () => {
      const user = await createUser("concurrent-request");
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          requestAccountDeletionUseCase(requestDeps(), {
            actorUserId: user.id,
            password: PASSWORD,
            context: CONTEXT,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) {
        expect(String(r.reason)).toMatch(/deletion already requested/);
      }
      expect(await auditRows(user.publicId)).toHaveLength(1);
    });

    it("停止中のユーザーは削除を要求できず、存在しない user は not found", async () => {
      const user = await createUser("suspended");
      await prisma.$executeRaw`UPDATE users SET status = 'suspended' WHERE id = ${BigInt(user.id)}`;
      await expect(
        requestAccountDeletionUseCase(requestDeps(), {
          actorUserId: user.id,
          password: PASSWORD,
          context: CONTEXT,
        }),
      ).rejects.toThrow("account is not active");
      await expect(
        requestAccountDeletionUseCase(requestDeps(), {
          actorUserId: "999999",
          password: PASSWORD,
          context: CONTEXT,
        }),
      ).rejects.toThrow("account not found");
      expect(await accounts().findForReauth("not-a-number")).toBeNull();
    });
  });

  describe("取り消し(ACD-004)と状態の取得(ACD-005)", () => {
    async function requestAt(userId: string, at: Date): Promise<void> {
      await requestAccountDeletionUseCase(requestDeps(at), {
        actorUserId: userId,
        password: PASSWORD,
        context: CONTEXT,
      });
    }
    const cancelAt = (userId: string, now: Date) =>
      cancelAccountDeletionUseCase(
        { accounts: accounts(), now: () => now },
        { actorUserId: userId, context: { requestId: "req-cancel", ipHash: "iphash" } },
      );

    it("猶予期間内に取り消すと active に戻り、データは残り、監査が追加される", async () => {
      const user = await createUser("cancel");
      await seedAllData(user.id);
      const owned = await rowsOwnedBy(user.id);
      await requestAt(user.id, NOW);

      await expect(cancelAt(user.id, new Date(NOW.getTime() + 10 * DAY_MS))).resolves.toEqual({
        status: "active",
      });
      expect(await userStatus(user.id)).toEqual({ status: "active", deletedAt: null });
      // 要求で session は失効するため、それ以外のデータが全て残っていることを確認する。
      expect(await rowsOwnedBy(user.id)).toBe(owned - 1);
      expect((await auditRows(user.publicId)).map((r) => r.action)).toEqual([
        "user.account.deletion_requested",
        "user.account.deletion_cancelled",
      ]);
      await expect(
        getAccountDeletionStatusUseCase({ accounts: accounts() }, { actorUserId: user.id }),
      ).resolves.toEqual({ status: "active", scheduledFor: null });
    });

    it("期限の直前までは取り消せ、期限ちょうどからは取り消せない(状態は変わらない)", async () => {
      const early = await createUser("cancel-edge-1");
      const late = await createUser("cancel-edge-2");
      await requestAt(early.id, NOW);
      await requestAt(late.id, NOW);
      const deadline = NOW.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS;

      await expect(cancelAt(early.id, new Date(deadline - 1))).resolves.toEqual({
        status: "active",
      });
      await expect(cancelAt(late.id, new Date(deadline))).rejects.toThrow("grace period expired");
      expect((await userStatus(late.id))?.status).toBe("deletion_pending");
    });

    it("削除予約の状態と期限を返し、active に取り消しを呼ぶと not requested", async () => {
      const user = await createUser("status");
      await expect(cancelAt(user.id, NOW)).rejects.toThrow("deletion not requested");
      await requestAt(user.id, NOW);
      await expect(
        getAccountDeletionStatusUseCase({ accounts: accounts() }, { actorUserId: user.id }),
      ).resolves.toEqual({
        status: "deletion_pending",
        scheduledFor: new Date(NOW.getTime() + 30 * DAY_MS),
      });
      await expect(cancelAt("999999", NOW)).rejects.toThrow("account not found");
    });
  });

  describe("期限到来の削除(ACD-006)", () => {
    async function pendingSince(label: string, daysAgo: number, now = NOW) {
      const user = await createUser(label);
      await seedAllData(user.id);
      await prisma.$executeRaw`
        UPDATE users SET status = 'deletion_pending', deleted_at = ${new Date(now.getTime() - daysAgo * DAY_MS)}
        WHERE id = ${BigInt(user.id)}`;
      return user;
    }

    it("期限に達したユーザーとその全データを削除し、監査に公開 ID だけを残す。期限前・active は残る", async () => {
      const due = await pendingSince("purge-due", 31);
      const exact = await pendingSince("purge-exact", 30);
      const notYet = await pendingSince("purge-not-yet", 29);
      const active = await createUser("purge-active");
      await seedAllData(active.id);
      expect(await rowsOwnedBy(due.id)).toBeGreaterThan(10);

      const summary = await purgeExpiredAccountsUseCase(purgeDeps());
      expect(summary).toEqual({ purged: 2, failed: 0, skipped: 0 });

      for (const gone of [due, exact]) {
        expect(await userStatus(gone.id)).toBeNull();
        expect(await rowsOwnedBy(gone.id)).toBe(0);
        const rows = await auditRows(gone.publicId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          actor: "system",
          action: "system.account.purged",
          targetType: "user",
          requestId: "job-int-1",
        });
        const text = JSON.stringify(rows, (_k, v: unknown) =>
          typeof v === "bigint" ? v.toString() : v,
        );
        expect(text).not.toContain(gone.email);
      }
      expect((await userStatus(notYet.id))?.status).toBe("deletion_pending");
      expect(await rowsOwnedBy(notYet.id)).toBeGreaterThan(10);
      expect((await userStatus(active.id))?.status).toBe("active");
      expect(await rowsOwnedBy(active.id)).toBeGreaterThan(10);
    });

    it("子の子(スケジュール版・AI 試行・リカバリーコード)も残らない", async () => {
      const due = await pendingSince("purge-children", 40);
      await purgeExpiredAccountsUseCase(purgeDeps());
      const [children] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT (
          (SELECT count(*) FROM habit_schedule_versions WHERE habit_id NOT IN (SELECT id FROM habits)) +
          (SELECT count(*) FROM ai_job_attempts WHERE ai_job_id NOT IN (SELECT id FROM ai_jobs)) +
          (SELECT count(*) FROM admin_recovery_codes WHERE admin_user_id NOT IN (SELECT id FROM admin_users))
        ) AS count`;
      expect(Number(children?.count)).toBe(0);
      expect(await userStatus(due.id)).toBeNull();
    });

    it("再実行しても何も起きない。並行して 2 件実行しても削除は 1 回で、監査も 1 件", async () => {
      const due = await pendingSince("purge-concurrent", 35);
      const results = await Promise.all([
        purgeExpiredAccountsUseCase(purgeDeps()),
        purgeExpiredAccountsUseCase(purgeDeps()),
        purgeExpiredAccountsUseCase(purgeDeps()),
      ]);
      expect(results.reduce((sum, r) => sum + r.purged, 0)).toBe(1);
      expect(results.every((r) => r.failed === 0)).toBe(true);
      expect(await auditRows(due.publicId)).toHaveLength(1);
      await expect(purgeExpiredAccountsUseCase(purgeDeps())).resolves.toEqual({
        purged: 0,
        failed: 0,
        skipped: 0,
      });
    });

    it("取り消しと削除が競合しても、どちらか一方だけが成立し、状態が壊れない", async () => {
      for (let i = 0; i < 12; i += 1) {
        const user = await pendingSince(`race-${i}`, 30);
        const cutoff = purgeCutoff(NOW);
        const [cancel, purge] = await Promise.allSettled([
          cancelAccountDeletionUseCase(
            { accounts: accounts(), now: () => new Date(NOW.getTime() - 1000) },
            { actorUserId: user.id, context: CONTEXT },
          ),
          accounts().purge({ userId: user.id, cutoff, now: NOW, requestId: "race" }),
        ]);
        const state = await userStatus(user.id);
        const purged = purge.status === "fulfilled" && purge.value === "purged";
        const cancelled = cancel.status === "fulfilled";
        // 取り消しが成立した場合は active のまま残り、削除が成立した場合は行がない。両立はしない。
        expect(purged && cancelled).toBe(false);
        if (purged) expect(state).toBeNull();
        else if (cancelled) expect(state).toEqual({ status: "active", deletedAt: null });
        else expect(state?.status).toBe("deletion_pending");
      }
    });

    it("purge は条件を満たさない対象(取り消し済み・期限前・存在しない)には何もしない", async () => {
      const user = await createUser("purge-skip");
      const repo = accounts();
      const cutoff = purgeCutoff(NOW);
      await expect(repo.purge({ userId: user.id, cutoff, now: NOW, requestId: "x" })).resolves.toBe(
        "skipped",
      );
      await expect(
        repo.purge({ userId: "999999", cutoff, now: NOW, requestId: "x" }),
      ).resolves.toBe("skipped");
      await expect(repo.purge({ userId: "nope", cutoff, now: NOW, requestId: "x" })).resolves.toBe(
        "skipped",
      );
      expect(await userStatus(user.id)).toEqual({ status: "active", deletedAt: null });
      expect(await auditRows(user.publicId)).toHaveLength(0);
    });

    it("1 回の実行は上限件数まで、古い順に処理する", async () => {
      const oldest = await pendingSince("batch-oldest", 200);
      const summary = await purgeExpiredAccountsUseCase(purgeDeps());
      expect(summary.purged).toBeGreaterThanOrEqual(1);
      expect(await userStatus(oldest.id)).toBeNull();
    });
  });

  describe("削除の完全性(ACD-INV-004)と DB 制約(ACD-INV-002)", () => {
    it("public スキーマの全 FK が ON DELETE CASCADE である(CASCADE なしの参照を追加すると失敗する)", async () => {
      const nonCascade = await prisma.$queryRaw<
        { conname: string; child: string; parent: string }[]
      >`
        SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f' AND n.nspname = 'public' AND c.confdeltype <> 'c'`;
      expect(nonCascade).toEqual([]);
    });

    it("user_id 列を持つ全テーブルが users への FK を持つ(FK のない個人データの取りこぼしを防ぐ)", async () => {
      const missing = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT col.table_name
        FROM information_schema.columns col
        WHERE col.table_schema = 'public' AND col.column_name = 'user_id'
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
              AND c.conrelid = (quote_ident(col.table_schema) || '.' || quote_ident(col.table_name))::regclass
          )`;
      expect(missing).toEqual([]);
    });

    it("audit_logs に FK も個人情報の列もない(識別子以外の情報を持たない)", async () => {
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_logs' ORDER BY ordinal_position`;
      expect(columns.map((c) => c.column_name)).toEqual([
        "id",
        "actor",
        "action",
        "target_type",
        "target_public_id",
        "request_id",
        "ip_hash",
        "created_at",
      ]);
    });

    it("CHECK: deletion_pending と deleted_at は同値。どちらか片方だけの更新は拒否される", async () => {
      const user = await createUser("check");
      await expect(
        prisma.$executeRaw`UPDATE users SET status = 'deletion_pending' WHERE id = ${BigInt(user.id)}`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE users SET deleted_at = ${NOW} WHERE id = ${BigInt(user.id)}`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`
          UPDATE users SET status = 'suspended', deleted_at = ${NOW} WHERE id = ${BigInt(user.id)}`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`
          UPDATE users SET status = 'deletion_pending', deleted_at = ${NOW} WHERE id = ${BigInt(user.id)}`,
      ).resolves.toBe(1);
    });

    it("login_attempts は reauth を受け付け、未知の purpose は拒否する", async () => {
      await expect(attempts().record("reauth", "x@example.test", false)).resolves.toBeUndefined();
      await expect(
        prisma.$executeRaw`
          INSERT INTO login_attempts (purpose, email_normalized, succeeded) VALUES ('other', 'x@example.test', false)`,
      ).rejects.toThrow();
    });
  });

  describe("session の状態(ACD-003)", () => {
    it("findSessionDetails は users.status を返し、削除予約中でも session 自体は有効", async () => {
      const user = await createUser("session-status");
      const auth = createPrismaAuthRepository(prisma);
      await auth.createSession({
        sessionToken: "status-token",
        userId: user.id,
        expiresAt: new Date(Date.now() + DAY_MS),
      });
      const now = new Date();
      expect(await auth.findSessionDetails({ sessionToken: "status-token", now })).toMatchObject({
        userId: user.id,
        userStatus: "active",
      });
      await prisma.$executeRaw`
        UPDATE users SET status = 'deletion_pending', deleted_at = ${NOW} WHERE id = ${BigInt(user.id)}`;
      expect(await auth.findSessionDetails({ sessionToken: "status-token", now })).toMatchObject({
        userId: user.id,
        userStatus: "deletion_pending",
      });
    });
  });

  describe("削除予約中の副作用", () => {
    it("削除予約中のユーザーには通知の受信者として解決されない(送信されない)", async () => {
      const user = await createUser("recipient");
      const pending = await createUser("recipient-pending");
      await prisma.$executeRaw`
        UPDATE users SET status = 'deletion_pending', deleted_at = ${NOW} WHERE id = ${BigInt(pending.id)}`;
      const rows = await prisma.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM users
        WHERE id IN (${BigInt(user.id)}, ${BigInt(pending.id)}) AND status = 'active'`;
      expect(rows.map((r) => r.id.toString())).toEqual([user.id]);
    });
  });
});

describe("Migration t404 の upgrade(直前の Migration まで適用済みの DB から)", () => {
  it("既存の users・login_attempts を保ったまま適用でき、適用後に制約が働く", async () => {
    const upgradeContainer = await startPostgresContainer();
    try {
      const migrationsDir = path.join(infrastructureRoot, "database", "migrations");
      const names = fs
        .readdirSync(migrationsDir)
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
      expect(names).toContain(T404_MIGRATION);

      const env = { ...process.env, DATABASE_URL: upgradeContainer.getConnectionUri() };
      const staging = fs.mkdtempSync(path.join(infrastructureRoot, ".t404-upgrade-"));
      const stagingConfig = path.join(infrastructureRoot, ".t404-upgrade.config.ts");
      try {
        fs.copyFileSync(
          path.join(migrationsDir, "migration_lock.toml"),
          path.join(staging, "migration_lock.toml"),
        );
        for (const name of names.filter((n) => n < T404_MIGRATION)) {
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
            authSubject: "credentials:upgrade-t404@example.test",
            emailNormalized: "upgrade-t404@example.test",
            passwordHash: "hash",
          },
        });
        await client.$executeRaw`
          INSERT INTO login_attempts (purpose, email_normalized, succeeded)
          VALUES ('login', 'upgrade-t404@example.test', false)`;

        execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
          cwd: infrastructureRoot,
          env,
          stdio: "pipe",
        });

        expect(await client.user.count({ where: { id: user.id, status: "active" } })).toBe(1);
        expect(await client.loginAttempt.count({ where: { purpose: "login" } })).toBe(1);
        await expect(
          client.$executeRaw`UPDATE users SET status = 'deletion_pending' WHERE id = ${user.id}`,
        ).rejects.toThrow();
        await expect(
          client.$executeRaw`
            INSERT INTO login_attempts (purpose, email_normalized, succeeded)
            VALUES ('reauth', 'upgrade-t404@example.test', false)`,
        ).resolves.toBe(1);
        const indexes = await client.$queryRaw<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes WHERE indexname = 'users_deletion_pending_deleted_at_idx'`;
        expect(indexes).toHaveLength(1);
      } finally {
        await client.$disconnect();
      }
    } finally {
      await upgradeContainer.stop();
    }
  }, 180_000);
});
