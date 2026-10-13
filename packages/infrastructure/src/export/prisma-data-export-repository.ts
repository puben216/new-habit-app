import type {
  DataExportRecord,
  DataExportRepositoryPort,
  ReadArtifactResult,
} from "@habit-app/application";
import {
  isAccountStatus,
  isDataExportFormat,
  isDataExportStatus,
  isExportExpired,
  userAuditActor,
} from "@habit-app/domain";
import type { DataExportFailureCode, DataExportFormat, DataExportStatus } from "@habit-app/domain";
import type { PrismaClient } from "../generated/prisma/client";
import { appendAudit, isUuid, parseUserId } from "../shared/db-helpers";

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(): Error {
  return new Error("persisted data export violates invariants");
}

/** 一覧・状態の query が返す列。成果物(bytea)は含めない(別テーブル)。 */
interface ExportRow {
  public_id: string;
  user_id: bigint;
  format: string;
  status: string;
  failure_code: string | null;
  byte_size: number | null;
  file_name: string | null;
  content_type: string | null;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
}

const FAILURE_CODES: readonly string[] = [
  "too_large",
  "generation_failed",
  "worker_error",
  "enqueue_failed",
];

function toRecord(row: ExportRow): DataExportRecord {
  if (!isDataExportFormat(row.format) || !isDataExportStatus(row.status)) throw corrupted();
  if (row.failure_code !== null && !FAILURE_CODES.includes(row.failure_code)) throw corrupted();
  return {
    id: row.public_id,
    userId: row.user_id.toString(),
    format: row.format as DataExportFormat,
    status: row.status as DataExportStatus,
    failureCode: row.failure_code as DataExportFailureCode | null,
    byteSize: row.byte_size,
    fileName: row.file_name,
    contentType: row.content_type,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

/**
 * DataExportRepositoryPort の Prisma 実装(docs/plans/data-export.md)。
 *
 * - 状態の遷移は条件付き更新の単一文(`WHERE status = ...`)で、読み取り後の更新をしない(EXP-INV-004)。
 *   claim の lease は DB の時刻(`updated_at < now() - lease`。`updated_at` は `set_updated_at` trigger が設定)で判定する。
 * - `queued`/`running` を 1 ユーザー 1 件にする部分 unique index が、同時作成の最後の砦。
 *   作成は users の行をロックして直列化し、頻度の数え方も同じ transaction で行う。
 * - 成果物は別テーブル。一覧・状態の query は本体を読まず、`SELECT *` を使わない。
 * - 所有者条件(`user_id = actor`)をすべての API 向け query に含める(EXP-INV-001)。
 * - 状態変更と監査は同一 transaction。ダウンロードは監査を先に追記してから成果物を読む(fail closed)。
 * - raw SQL は `$queryRaw`/`$executeRaw` のタグ付きテンプレート(バインド変数のみ)。
 */
export function createPrismaDataExportRepository(prisma: PrismaClient): DataExportRepositoryPort {
  async function findRow(publicId: string): Promise<ExportRow | undefined> {
    const rows = await prisma.$queryRaw<ExportRow[]>`
      SELECT public_id, user_id, format, status, failure_code, byte_size, file_name, content_type,
             created_at, completed_at, expires_at
      FROM data_exports WHERE public_id = ${publicId}::uuid`;
    return rows[0];
  }

  return {
    async createIfAllowed({
      actorUserId,
      format,
      now,
      windowStart,
      dailyLimit,
      staleBefore,
      context,
    }) {
      const userId = parseUserId(actorUserId);
      if (userId === null) return { status: "not_found" };
      try {
        return await prisma.$transaction(async (tx) => {
          // users の行をロックして、同じユーザーの作成を直列化する(存在の確認も兼ねる)。
          const locked = await tx.$queryRaw<{ public_id: string; status: string }[]>`
            SELECT public_id, status FROM users WHERE id = ${userId} FOR UPDATE`;
          const user = locked[0];
          if (user === undefined || !isAccountStatus(user.status)) {
            return { status: "not_found" } as const;
          }

          // 長く更新されない queued/running は停止したとみなして失敗にし、作成を妨げない。
          await tx.$executeRaw`
            UPDATE data_exports SET status = 'failed', failure_code = 'worker_error'
            WHERE user_id = ${userId} AND status IN ('queued', 'running')
              AND updated_at <= ${staleBefore}`;

          const active = await tx.$queryRaw<{ one: number }[]>`
            SELECT 1 AS one FROM data_exports
            WHERE user_id = ${userId} AND status IN ('queued', 'running') LIMIT 1`;
          if (active.length > 0) return { status: "in_progress" } as const;

          const recent = await tx.$queryRaw<{ count: bigint }[]>`
            SELECT count(*) AS count FROM data_exports
            WHERE user_id = ${userId} AND created_at >= ${windowStart}`;
          if (Number(recent[0]?.count ?? 0) >= dailyLimit)
            return { status: "rate_limited" } as const;

          // 完成済みの古いエクスポートは、新しいものを作ると無効になる(成果物を削除する)。
          await tx.$executeRaw`
            DELETE FROM data_export_artifacts
            WHERE export_id IN (
              SELECT id FROM data_exports WHERE user_id = ${userId} AND status = 'ready')`;
          await tx.$executeRaw`
            UPDATE data_exports SET status = 'expired'
            WHERE user_id = ${userId} AND status = 'ready'`;

          const inserted = await tx.$queryRaw<ExportRow[]>`
            INSERT INTO data_exports (user_id, format, status, created_at, updated_at)
            VALUES (${userId}, ${format}, 'queued', ${now}, ${now})
            RETURNING public_id, user_id, format, status, failure_code, byte_size, file_name,
                      content_type, created_at, completed_at, expires_at`;
          const row = inserted[0];
          if (row === undefined) throw corrupted();

          await appendAudit(tx, {
            actor: userAuditActor(user.public_id),
            action: "user.export.requested",
            targetType: "data_export",
            targetPublicId: row.public_id,
            requestId: context.requestId,
            ipHash: context.ipHash,
            now,
          });
          return { status: "created", export: toRecord(row) } as const;
        });
      } catch (error) {
        // 部分 unique index の衝突(ロックをすり抜けた同時作成)も「実行中」として扱う。
        if (error instanceof Error && error.message.includes("data_exports_user_active_uidx")) {
          return { status: "in_progress" };
        }
        throw error;
      }
    },

    async list({ actorUserId, limit }) {
      const userId = parseUserId(actorUserId);
      if (userId === null) return [];
      const rows = await prisma.$queryRaw<ExportRow[]>`
        SELECT public_id, user_id, format, status, failure_code, byte_size, file_name, content_type,
               created_at, completed_at, expires_at
        FROM data_exports WHERE user_id = ${userId}
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
      return rows.map(toRecord);
    },

    async claim({ exportId, leaseSeconds }) {
      if (!isUuid(exportId)) return { status: "not_found" };
      const claimed = await prisma.$queryRaw<ExportRow[]>`
        UPDATE data_exports SET status = 'running'
        WHERE public_id = ${exportId}::uuid
          AND (status = 'queued'
               OR (status = 'running' AND updated_at < now() - make_interval(secs => ${leaseSeconds}::double precision)))
        RETURNING public_id, user_id, format, status, failure_code, byte_size, file_name,
                  content_type, created_at, completed_at, expires_at`;
      const row = claimed[0];
      if (row !== undefined) return { status: "claimed", export: toRecord(row) };

      const current = await findRow(exportId);
      if (current === undefined) return { status: "not_found" };
      return current.status === "running" ? { status: "in_progress" } : { status: "finished" };
    },

    async complete({ exportId, content, fileName, contentType, completedAt, expiresAt }) {
      if (!isUuid(exportId)) return "lost";
      return prisma.$transaction(async (tx) => {
        const updated = await tx.$queryRaw<{ id: bigint }[]>`
          UPDATE data_exports
          SET status = 'ready', byte_size = ${content.length}, file_name = ${fileName},
              content_type = ${contentType}, completed_at = ${completedAt}, expires_at = ${expiresAt}
          WHERE public_id = ${exportId}::uuid AND status = 'running'
          RETURNING id`;
        const row = updated[0];
        if (row === undefined) return "lost";
        await tx.$executeRaw`
          INSERT INTO data_export_artifacts (export_id, content)
          VALUES (${row.id}, ${Buffer.from(content)})
          ON CONFLICT (export_id) DO UPDATE SET content = EXCLUDED.content`;
        return "completed";
      });
    },

    async fail({ exportId, failureCode }) {
      if (!isUuid(exportId)) return;
      await prisma.$executeRaw`
        UPDATE data_exports SET status = 'failed', failure_code = ${failureCode}
        WHERE public_id = ${exportId}::uuid AND status IN ('queued', 'running')`;
    },

    async release({ exportId }) {
      if (!isUuid(exportId)) return;
      await prisma.$executeRaw`
        UPDATE data_exports SET status = 'queued'
        WHERE public_id = ${exportId}::uuid AND status = 'running'`;
    },

    async readArtifact({ actorUserId, exportId, now, context }): Promise<ReadArtifactResult> {
      const userId = parseUserId(actorUserId);
      if (userId === null || !isUuid(exportId)) return { status: "not_found" };
      return prisma.$transaction(async (tx) => {
        const found = await tx.$queryRaw<(ExportRow & { id: bigint; user_public_id: string })[]>`
          SELECT e.id, e.public_id, e.user_id, e.format, e.status, e.failure_code, e.byte_size,
                 e.file_name, e.content_type, e.created_at, e.completed_at, e.expires_at,
                 u.public_id AS user_public_id
          FROM data_exports e JOIN users u ON u.id = e.user_id
          WHERE e.public_id = ${exportId}::uuid AND e.user_id = ${userId}`;
        const row = found[0];
        if (row === undefined) return { status: "not_found" } as const;
        if (row.status === "expired") return { status: "expired" } as const;
        if (row.status !== "ready") return { status: "not_ready" } as const;
        if (row.expires_at === null) throw corrupted();
        if (isExportExpired(row.expires_at, now)) return { status: "expired" } as const;

        // 監査が先。追記に失敗したら例外になり、成果物を読まない(fail closed)。
        await appendAudit(tx, {
          actor: userAuditActor(row.user_public_id),
          action: "user.export.downloaded",
          targetType: "data_export",
          targetPublicId: row.public_id,
          requestId: context.requestId,
          ipHash: context.ipHash,
          now,
        });
        const artifact = await tx.$queryRaw<{ content: Uint8Array }[]>`
          SELECT content FROM data_export_artifacts WHERE export_id = ${row.id}`;
        const content = artifact[0]?.content;
        if (content === undefined) throw corrupted();
        return {
          status: "ok",
          export: toRecord(row),
          content: new Uint8Array(content),
        } as const;
      });
    },

    async expireDue({ now, limit }) {
      return prisma.$transaction(async (tx) => {
        const due = await tx.$queryRaw<{ id: bigint }[]>`
          SELECT id FROM data_exports
          WHERE status = 'ready' AND expires_at <= ${now}
          ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
        if (due.length === 0) return 0;
        const ids = due.map((row) => row.id);
        await tx.$executeRaw`DELETE FROM data_export_artifacts WHERE export_id = ANY(${ids}::bigint[])`;
        await tx.$executeRaw`
          UPDATE data_exports SET status = 'expired' WHERE id = ANY(${ids}::bigint[])`;
        return ids.length;
      });
    },

    async failStale({ cutoff, limit }) {
      return prisma.$executeRaw`
        UPDATE data_exports SET status = 'failed', failure_code = 'worker_error'
        WHERE id IN (
          SELECT id FROM data_exports
          WHERE status IN ('queued', 'running') AND updated_at <= ${cutoff}
          ORDER BY updated_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
    },

    async deleteClosed({ cutoff, limit }) {
      return prisma.$executeRaw`
        DELETE FROM data_exports
        WHERE id IN (
          SELECT id FROM data_exports
          WHERE status IN ('failed', 'expired') AND updated_at <= ${cutoff}
          ORDER BY updated_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
    },
  };
}
