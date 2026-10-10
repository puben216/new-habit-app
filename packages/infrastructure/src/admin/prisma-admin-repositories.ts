import type {
  AdminAccount,
  AdminAccountRepositoryPort,
  AdminProvisioningPort,
  AdminReadPort,
  AuditLogPort,
  SessionMfaPort,
} from "@habit-app/application";
import type { PrismaClient } from "../generated/prisma/client";
import { UUID_PATTERN, calendarDateFromDate, parseBigintId } from "../notifications/shared";

/**
 * 管理機能の Prisma 実装(docs/plans/minimal-admin.md)。
 *
 * - 状態を変える文はすべて単一の条件付き文(または 1 transaction)で、読み取り後の更新をしない。
 *   並行する MFA 検証でも、失敗カウント・replay 防止・リカバリーコードの単回使用が破れない。
 * - raw SQL は `$queryRaw` / `$executeRaw` のタグ付きテンプレート(バインド変数のみ)。
 * - 値(秘密・コード・email)を例外メッセージに含めない。
 */

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(what: string): Error {
  return new Error(`persisted ${what} violates invariants`);
}

interface AdminAccountRow {
  id: string;
  public_id: string;
  user_id: string;
  totp_secret_enc: string;
  totp_last_step: bigint | null;
  mfa_failed_attempts: number;
  mfa_locked_until: Date | null;
}

export function createPrismaAdminAccountRepository(
  prisma: PrismaClient,
): AdminAccountRepositoryPort {
  return {
    async findActiveByUserId(userId) {
      const id = parseBigintId(userId);
      if (id === null) return null;
      const rows = await prisma.$queryRaw<AdminAccountRow[]>`
        SELECT a.id::text AS id, a.public_id::text AS public_id, a.user_id::text AS user_id,
               a.totp_secret_enc, a.totp_last_step, a.mfa_failed_attempts, a.mfa_locked_until
        FROM admin_users a
        JOIN users u ON u.id = a.user_id
        WHERE a.user_id = ${id}
          AND a.status = 'active'
          AND u.status = 'active'
          AND u.deleted_at IS NULL`;
      const row = rows[0];
      if (row === undefined) return null;
      const lastStep = row.totp_last_step === null ? null : Number(row.totp_last_step);
      if (lastStep !== null && !Number.isSafeInteger(lastStep)) throw corrupted("admin account");
      const account: AdminAccount = {
        adminId: row.id,
        adminPublicId: row.public_id,
        userId: row.user_id,
        totpSecretEnc: row.totp_secret_enc,
        totpLastStep: lastStep,
        failedAttempts: row.mfa_failed_attempts,
        lockedUntil: row.mfa_locked_until,
      };
      return account;
    },

    async recordTotpSuccess({ adminId, step }) {
      const id = parseBigintId(adminId);
      if (id === null || !Number.isSafeInteger(step) || step < 0) return false;
      const updated = await prisma.$executeRaw`
        UPDATE admin_users
        SET totp_last_step = ${BigInt(step)}, mfa_failed_attempts = 0, mfa_locked_until = NULL
        WHERE id = ${id}
          AND status = 'active'
          AND (totp_last_step IS NULL OR totp_last_step < ${BigInt(step)})`;
      return updated > 0;
    },

    async consumeRecoveryCode({ adminId, codeHash, now }) {
      const id = parseBigintId(adminId);
      if (id === null) return false;
      // コードの使用済み化と失敗カウントの解除を 1 文で行う(使えたときだけ解除される)。
      const updated = await prisma.$executeRaw`
        WITH used AS (
          UPDATE admin_recovery_codes
          SET used_at = ${now}
          WHERE admin_user_id = ${id} AND code_hash = ${codeHash} AND used_at IS NULL
          RETURNING admin_user_id
        )
        UPDATE admin_users
        SET mfa_failed_attempts = 0, mfa_locked_until = NULL
        WHERE id IN (SELECT admin_user_id FROM used) AND status = 'active'`;
      return updated > 0;
    },

    async recordMfaFailure({ adminId, now, maxAttempts, lockoutMs }) {
      const id = parseBigintId(adminId);
      if (id === null) return { locked: false, lockedUntil: null };
      const lockoutSeconds = lockoutMs / 1000;
      // ロック明けの失敗は 1 回目から数え直し、上限に達したらロックする。単一の UPDATE で原子的に行う。
      const rows = await prisma.$queryRaw<{ mfa_locked_until: Date | null }[]>`
        UPDATE admin_users
        SET mfa_failed_attempts = CASE
              WHEN mfa_locked_until IS NOT NULL AND mfa_locked_until <= ${now} THEN 1
              ELSE mfa_failed_attempts + 1 END,
            mfa_locked_until = CASE
              WHEN (CASE WHEN mfa_locked_until IS NOT NULL AND mfa_locked_until <= ${now} THEN 1
                         ELSE mfa_failed_attempts + 1 END) >= ${maxAttempts}
                THEN ${now}::timestamptz + make_interval(secs => ${lockoutSeconds}::double precision)
              WHEN mfa_locked_until IS NOT NULL AND mfa_locked_until <= ${now} THEN NULL
              ELSE mfa_locked_until END
        WHERE id = ${id}
        RETURNING mfa_locked_until`;
      const lockedUntil = rows[0]?.mfa_locked_until ?? null;
      return { locked: lockedUntil !== null && lockedUntil > now, lockedUntil };
    },
  };
}

export function createPrismaSessionMfaRepository(prisma: PrismaClient): SessionMfaPort {
  return {
    async markVerified({ sessionId, userId, now }) {
      const id = parseBigintId(sessionId);
      const actor = parseBigintId(userId);
      if (id === null || actor === null) return false;
      // actor 自身の session だけを対象にし、失効済みの session は検証済みにしない。
      const updated = await prisma.$executeRaw`
        UPDATE sessions SET mfa_verified_at = ${now}
        WHERE id = ${id} AND user_id = ${actor} AND expires > ${now}`;
      return updated > 0;
    },

    async clearVerified({ sessionId, userId }) {
      const id = parseBigintId(sessionId);
      const actor = parseBigintId(userId);
      if (id === null || actor === null) return;
      await prisma.$executeRaw`
        UPDATE sessions SET mfa_verified_at = NULL WHERE id = ${id} AND user_id = ${actor}`;
    },
  };
}

/**
 * 監査ログの追記(ADM-INV-004/005)。失敗は例外にして呼び出し側に伝える(閲覧は行わない)。
 * UPDATE/DELETE/TRUNCATE は DB の trigger が拒否する。
 */
export function createPrismaAuditLogRepository(prisma: PrismaClient): AuditLogPort {
  return {
    async append(entry) {
      if (entry.targetPublicId !== null && !UUID_PATTERN.test(entry.targetPublicId)) {
        throw new Error("audit target must be a uuid");
      }
      await prisma.$executeRaw`
        INSERT INTO audit_logs (actor, action, target_type, target_public_id, request_id, ip_hash, created_at)
        VALUES (${entry.actor}, ${entry.action}, ${entry.targetType},
                ${entry.targetPublicId}::uuid, ${entry.requestId}, ${entry.ipHash}, ${entry.now})`;
    },
  };
}

function countsByStatus(rows: { status: string; count: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

/**
 * 閲覧専用の問い合わせ(ADM-004〜007)。返す列は allowlist のみで、習慣・記録・メモ・通知設定の中身、
 * AI の入出力(`result_json`、`input_fingerprint`)、provider の応答を読まない。
 */
export function createPrismaAdminReadRepository(prisma: PrismaClient): AdminReadPort {
  return {
    async findUserByEmail(emailNormalized) {
      const rows = await prisma.$queryRaw<
        { public_id: string; email_normalized: string; status: string; created_at: Date }[]
      >`
        SELECT public_id::text AS public_id, email_normalized, status, created_at
        FROM users
        WHERE email_normalized = ${emailNormalized}`;
      const row = rows[0];
      return row === undefined
        ? null
        : {
            publicId: row.public_id,
            email: row.email_normalized,
            status: row.status,
            createdAt: row.created_at,
          };
    },

    async getUserOverview({ publicId, since }) {
      if (!UUID_PATTERN.test(publicId)) return null;
      const users = await prisma.$queryRaw<
        {
          id: bigint;
          public_id: string;
          email_normalized: string;
          status: string;
          created_at: Date;
          email_verified: boolean;
        }[]
      >`
        SELECT id, public_id::text AS public_id, email_normalized, status, created_at,
               (email_verified_at IS NOT NULL) AS email_verified
        FROM users
        WHERE public_id = ${publicId}::uuid`;
      const user = users[0];
      if (user === undefined) return null;

      const [deliveries, aiJobs, suppressions] = await Promise.all([
        prisma.$queryRaw<{ status: string; count: number }[]>`
          SELECT status, COUNT(*)::int AS count
          FROM notification_deliveries
          WHERE user_id = ${user.id} AND created_at >= ${since}
          GROUP BY status`,
        prisma.$queryRaw<{ status: string; count: number }[]>`
          SELECT status, COUNT(*)::int AS count
          FROM ai_jobs
          WHERE user_id = ${user.id} AND created_at >= ${since}
          GROUP BY status`,
        prisma.$queryRaw<{ one: number }[]>`
          SELECT 1 AS one FROM email_suppressions WHERE user_id = ${user.id}`,
      ]);
      return {
        publicId: user.public_id,
        email: user.email_normalized,
        status: user.status,
        createdAt: user.created_at,
        emailVerified: user.email_verified,
        suppressed: suppressions.length > 0,
        notificationDeliveries: countsByStatus(deliveries),
        aiJobs: countsByStatus(aiJobs),
      };
    },

    async listNotificationFailures({ statuses, limit, afterId }) {
      const after = afterId === null ? null : parseBigintId(afterId);
      if (afterId !== null && after === null) return [];
      const rows = await prisma.$queryRaw<
        {
          id: string;
          user_public_id: string;
          status: string;
          failure_code: string | null;
          attempt_count: number;
          scheduled_at: Date;
          local_date: Date;
          updated_at: Date;
        }[]
      >`
        SELECT d.id::text AS id, u.public_id::text AS user_public_id, d.status, d.failure_code,
               d.attempt_count, d.scheduled_at, d.local_date, d.updated_at
        FROM notification_deliveries d
        JOIN users u ON u.id = d.user_id
        WHERE d.status = ANY(${[...statuses]}::text[])
          AND (${after}::bigint IS NULL OR d.id < ${after}::bigint)
        ORDER BY d.id DESC
        LIMIT ${limit}`;
      return rows.map((row) => ({
        id: row.id,
        userPublicId: row.user_public_id,
        status: row.status,
        failureCode: row.failure_code,
        attemptCount: row.attempt_count,
        scheduledAt: row.scheduled_at,
        localDate: calendarDateFromDate(row.local_date),
        updatedAt: row.updated_at,
      }));
    },

    async listAiJobFailures({ statuses, limit, afterId }) {
      const after = afterId === null ? null : parseBigintId(afterId);
      if (afterId !== null && after === null) return [];
      const rows = await prisma.$queryRaw<
        {
          id: string;
          public_id: string;
          user_public_id: string;
          kind: string;
          status: string;
          failure_code: string | null;
          provider: string;
          model: string;
          prompt_version: string;
          created_at: Date;
        }[]
      >`
        SELECT j.id::text AS id, j.public_id::text AS public_id, u.public_id::text AS user_public_id,
               j.kind, j.status, j.failure_code, j.provider, j.model, j.prompt_version, j.created_at
        FROM ai_jobs j
        JOIN users u ON u.id = j.user_id
        WHERE j.status = ANY(${[...statuses]}::text[])
          AND (${after}::bigint IS NULL OR j.id < ${after}::bigint)
        ORDER BY j.id DESC
        LIMIT ${limit}`;
      return rows.map((row) => ({
        cursorId: row.id,
        publicId: row.public_id,
        userPublicId: row.user_public_id,
        kind: row.kind,
        status: row.status,
        failureCode: row.failure_code,
        provider: row.provider,
        model: row.model,
        promptVersion: row.prompt_version,
        createdAt: row.created_at,
      }));
    },
  };
}

/**
 * 運用スクリプト用の付与・無効化(ADM-001)。Web/API からは使わない。
 * 各操作は 1 transaction で、全 session の MFA 検証を無効にする。
 */
export function createPrismaAdminProvisioningRepository(
  prisma: PrismaClient,
): AdminProvisioningPort {
  return {
    async findEligibleUserByEmail(emailNormalized) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id
        FROM users
        WHERE email_normalized = ${emailNormalized}
          AND status = 'active'
          AND deleted_at IS NULL
          AND email_verified_at IS NOT NULL`;
      const row = rows[0];
      return row === undefined ? null : { userId: row.id };
    },

    async grant({ userId, totpSecretEnc, recoveryCodeHashes }) {
      const id = parseBigintId(userId);
      if (id === null) return { status: "already_active" };
      return prisma.$transaction(async (tx) => {
        const existing = await tx.$queryRaw<{ id: bigint; status: string }[]>`
          SELECT id, status FROM admin_users WHERE user_id = ${id} FOR UPDATE`;
        const current = existing[0];
        if (current?.status === "active") return { status: "already_active" as const };

        let adminId: bigint;
        let adminPublicId: string;
        if (current === undefined) {
          const created = await tx.$queryRaw<{ id: bigint; public_id: string }[]>`
            INSERT INTO admin_users (user_id, totp_secret_enc)
            VALUES (${id}, ${totpSecretEnc})
            RETURNING id, public_id::text AS public_id`;
          const row = created[0];
          if (row === undefined) throw corrupted("admin account");
          adminId = row.id;
          adminPublicId = row.public_id;
        } else {
          const reactivated = await tx.$queryRaw<{ id: bigint; public_id: string }[]>`
            UPDATE admin_users
            SET status = 'active', totp_secret_enc = ${totpSecretEnc}, totp_last_step = NULL,
                mfa_failed_attempts = 0, mfa_locked_until = NULL
            WHERE id = ${current.id}
            RETURNING id, public_id::text AS public_id`;
          const row = reactivated[0];
          if (row === undefined) throw corrupted("admin account");
          adminId = row.id;
          adminPublicId = row.public_id;
        }
        await replaceRecoveryCodes(tx, adminId, recoveryCodeHashes);
        await tx.$executeRaw`UPDATE sessions SET mfa_verified_at = NULL WHERE user_id = ${id}`;
        return { status: "granted" as const, adminPublicId };
      });
    },

    async disable({ userId }) {
      const id = parseBigintId(userId);
      if (id === null) return null;
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ public_id: string }[]>`
          UPDATE admin_users SET status = 'disabled'
          WHERE user_id = ${id} AND status = 'active'
          RETURNING public_id::text AS public_id`;
        const row = rows[0];
        if (row === undefined) return null;
        await tx.$executeRaw`UPDATE sessions SET mfa_verified_at = NULL WHERE user_id = ${id}`;
        return { adminPublicId: row.public_id };
      });
    },

    async resetMfa({ userId, totpSecretEnc, recoveryCodeHashes }) {
      const id = parseBigintId(userId);
      if (id === null) return null;
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: bigint; public_id: string }[]>`
          UPDATE admin_users
          SET totp_secret_enc = ${totpSecretEnc}, totp_last_step = NULL,
              mfa_failed_attempts = 0, mfa_locked_until = NULL
          WHERE user_id = ${id} AND status = 'active'
          RETURNING id, public_id::text AS public_id`;
        const row = rows[0];
        if (row === undefined) return null;
        await replaceRecoveryCodes(tx, row.id, recoveryCodeHashes);
        await tx.$executeRaw`UPDATE sessions SET mfa_verified_at = NULL WHERE user_id = ${id}`;
        return { adminPublicId: row.public_id };
      });
    },
  };
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function replaceRecoveryCodes(
  tx: Tx,
  adminId: bigint,
  hashes: readonly string[],
): Promise<void> {
  await tx.$executeRaw`DELETE FROM admin_recovery_codes WHERE admin_user_id = ${adminId}`;
  for (const hash of hashes) {
    await tx.$executeRaw`
      INSERT INTO admin_recovery_codes (admin_user_id, code_hash) VALUES (${adminId}, ${hash})`;
  }
}
