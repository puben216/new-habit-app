import type { EmailSuppressionPort, RecipientPort } from "@habit-app/application";
import type { PrismaClient } from "../generated/prisma/client";
import { parseBigintId } from "./shared";

/**
 * EmailSuppressionPort の Prisma 実装(docs/specs/notification-delivery.md NDL-008)。
 * `suppress` は `INSERT ... SELECT FROM users ... ON CONFLICT (user_id) DO NOTHING` の単一文で、
 * 何度呼んでも 1 件のまま、存在しないユーザーでも FK 違反にならない。
 */
export function createPrismaEmailSuppressionRepository(prisma: PrismaClient): EmailSuppressionPort {
  return {
    async isSuppressed(userId) {
      const id = parseBigintId(userId);
      if (id === null) return false;
      const rows = await prisma.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM email_suppressions WHERE user_id = ${id}`;
      return rows.length > 0;
    },

    async suppress({ userId, reason, now }) {
      const id = parseBigintId(userId);
      if (id === null) return;
      await prisma.$executeRaw`
        INSERT INTO email_suppressions (user_id, reason, created_at)
        SELECT u.id, ${reason}, ${now}
        FROM users u
        WHERE u.id = ${id}
        ON CONFLICT (user_id) DO NOTHING`;
    },
  };
}

/**
 * RecipientPort の Prisma 実装。送信直前にだけ呼ばれ、email は戻り値としてのみ返す(保存・ログしない)。
 * 有効な(`active`、削除されていない)かつ email 確認済みのユーザーだけを宛先にする。
 */
export function createPrismaRecipientRepository(prisma: PrismaClient): RecipientPort {
  return {
    async findRecipient(userId) {
      const id = parseBigintId(userId);
      if (id === null) return null;
      const rows = await prisma.$queryRaw<{ public_id: string; email_normalized: string }[]>`
        SELECT public_id::text AS public_id, email_normalized
        FROM users
        WHERE id = ${id}
          AND status = 'active'
          AND deleted_at IS NULL
          AND email_verified_at IS NOT NULL`;
      const row = rows[0];
      return row === undefined
        ? null
        : { email: row.email_normalized, userPublicId: row.public_id };
    },
  };
}
