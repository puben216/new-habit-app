import type { AccountRepositoryPort, ExternalDataCleanupPort } from "@habit-app/application";
import { isAccountStatus, SYSTEM_AUDIT_ACTOR, userAuditActor } from "@habit-app/domain";
import type { Prisma, PrismaClient } from "../generated/prisma/client";

const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** user ID(session 由来の十進文字列)を bigint へ。形式不正は「何にも到達できない」扱い。 */
function parseUserId(userId: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(userId)) return null;
  const value = BigInt(userId);
  return value <= MAX_BIGINT ? value : null;
}

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(): Error {
  return new Error("persisted account violates invariants");
}

type Tx = Prisma.TransactionClient;

interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly targetPublicId: string;
  readonly requestId: string;
  readonly ipHash: string;
  readonly now: Date;
}

/** 状態変更と同一 transaction で監査を追記する(ACD-INV-006)。内容・メール・パスワードは記録しない。 */
async function appendAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_logs (actor, action, target_type, target_public_id, request_id, ip_hash, created_at)
    VALUES (${entry.actor}, ${entry.action}, 'user', ${entry.targetPublicId}::uuid,
            ${entry.requestId}, ${entry.ipHash}, ${entry.now})`;
}

/**
 * AccountRepositoryPort の Prisma 実装(docs/plans/account-deletion.md)。
 *
 * - 状態の変更は条件付き更新の単一文(`WHERE status = ...`)で、読み取り後の更新をしない(ACD-INV-002/007)。
 *   並行する要求・取り消し・削除は、同じ行の更新・ロックで直列化され、どれか 1 つだけが成立する。
 * - 状態の変更と監査の追記は同一 transaction。片方だけが成立しない(ACD-INV-006)。
 * - 削除は `DELETE FROM users` で、子データは `ON DELETE CASCADE` が削除する(ACD-INV-004)。
 * - raw SQL は `$queryRaw`/`$executeRaw` のタグ付きテンプレート(バインド変数のみ)。
 */
export function createPrismaAccountRepository(prisma: PrismaClient): AccountRepositoryPort {
  return {
    async findForReauth(userId) {
      const id = parseUserId(userId);
      if (id === null) return null;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { emailNormalized: true, passwordHash: true, status: true },
      });
      if (user === null) return null;
      if (!isAccountStatus(user.status)) throw corrupted();
      return {
        emailNormalized: user.emailNormalized,
        passwordHash: user.passwordHash,
        status: user.status,
      };
    },

    async requestDeletion({ userId, now, context }) {
      const id = parseUserId(userId);
      if (id === null) return "not_found";
      return prisma.$transaction(async (tx) => {
        const updated = await tx.$queryRaw<{ public_id: string }[]>`
          UPDATE users SET status = 'deletion_pending', deleted_at = ${now}
          WHERE id = ${id} AND status = 'active'
          RETURNING public_id`;
        const row = updated[0];
        if (row !== undefined) {
          // 全 session を失効させる(以後は再ログインで取り消し画面にだけ入れる)。
          await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${id}`;
          await appendAudit(tx, {
            actor: userAuditActor(row.public_id),
            action: "user.account.deletion_requested",
            targetPublicId: row.public_id,
            requestId: context.requestId,
            ipHash: context.ipHash,
            now,
          });
          return "requested";
        }
        const current = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM users WHERE id = ${id}`;
        const status = current[0]?.status;
        if (status === undefined) return "not_found";
        return status === "deletion_pending" ? "already_requested" : "not_active";
      });
    },

    async cancelDeletion({ userId, now, cutoff, context }) {
      const id = parseUserId(userId);
      if (id === null) return "not_found";
      return prisma.$transaction(async (tx) => {
        const updated = await tx.$queryRaw<{ public_id: string }[]>`
          UPDATE users SET status = 'active', deleted_at = NULL
          WHERE id = ${id} AND status = 'deletion_pending' AND deleted_at > ${cutoff}
          RETURNING public_id`;
        const row = updated[0];
        if (row !== undefined) {
          await appendAudit(tx, {
            actor: userAuditActor(row.public_id),
            action: "user.account.deletion_cancelled",
            targetPublicId: row.public_id,
            requestId: context.requestId,
            ipHash: context.ipHash,
            now,
          });
          return "cancelled";
        }
        const current = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM users WHERE id = ${id}`;
        const status = current[0]?.status;
        if (status === undefined) return "not_found";
        return status === "deletion_pending" ? "expired" : "not_requested";
      });
    },

    async findDeletionState(userId) {
      const id = parseUserId(userId);
      if (id === null) return null;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { status: true, deletedAt: true },
      });
      if (user === null) return null;
      if (!isAccountStatus(user.status)) throw corrupted();
      return { status: user.status, deletedAt: user.deletedAt };
    },

    async findDueForPurge({ cutoff, limit }) {
      const rows = await prisma.$queryRaw<{ id: bigint; public_id: string }[]>`
        SELECT id, public_id FROM users
        WHERE status = 'deletion_pending' AND deleted_at <= ${cutoff}
        ORDER BY deleted_at, id
        LIMIT ${limit}`;
      return rows.map((row) => ({ userId: row.id.toString(), userPublicId: row.public_id }));
    },

    async purge({ userId, cutoff, now, requestId }) {
      const id = parseUserId(userId);
      if (id === null) return "skipped";
      return prisma.$transaction(async (tx) => {
        // 行をロックして条件を再確認する。取り消し・並行ジョブと競合したら、先に成立した方が勝つ。
        const locked = await tx.$queryRaw<{ public_id: string }[]>`
          SELECT public_id FROM users
          WHERE id = ${id} AND status = 'deletion_pending' AND deleted_at <= ${cutoff}
          FOR UPDATE`;
        const row = locked[0];
        if (row === undefined) return "skipped";
        await appendAudit(tx, {
          actor: SYSTEM_AUDIT_ACTOR,
          action: "system.account.purged",
          targetPublicId: row.public_id,
          requestId,
          ipHash: "none",
          now,
        });
        await tx.$executeRaw`DELETE FROM users WHERE id = ${id}`;
        return "purged";
      });
    },
  };
}

/**
 * 何もしない片付け。AI・メールの provider が未確定(ADR-003)のため、現時点で DB の外に削除すべき
 * データはない。provider を実装する際に、冪等な削除の実装へ差し替える。
 */
export function createNoopExternalDataCleanup(): ExternalDataCleanupPort {
  return { async cleanup() {} };
}
