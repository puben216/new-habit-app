import type {
  UpdateWeeklyReviewResult,
  WeeklyReviewRecord,
  WeeklyReviewRepositoryPort,
  WeeklyReviewStatus,
} from "@habit-app/application";
import type { PrismaClient } from "../generated/prisma/client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** actor の user ID(session 由来の十進文字列)を bigint へ。形式不正は「何にも到達できない」扱い。 */
function parseUserId(actorUserId: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(actorUserId)) return null;
  const value = BigInt(actorUserId);
  return value <= MAX_BIGINT ? value : null;
}

function dateFromCalendarDate(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

function calendarDateFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(): Error {
  return new Error("persisted weekly review violates invariants");
}

function toStatus(value: string): WeeklyReviewStatus {
  if (value !== "draft" && value !== "completed") throw corrupted();
  return value;
}

interface ReviewRow {
  public_id: string;
  week_start: Date;
  timezone_snapshot: string;
  summary_json: unknown;
  reflection: string | null;
  status: string;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: {
  publicId: string;
  weekStart: Date;
  timezone: string;
  summary: unknown;
  reflection: string | null;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WeeklyReviewRecord {
  return {
    id: row.publicId,
    weekStart: calendarDateFromDate(row.weekStart),
    timezone: row.timezone,
    summary: row.summary,
    reflection: row.reflection,
    status: toStatus(row.status),
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function fromRawRow(row: ReviewRow): WeeklyReviewRecord {
  return toRecord({
    publicId: row.public_id,
    weekStart: row.week_start,
    timezone: row.timezone_snapshot,
    summary: row.summary_json,
    reflection: row.reflection,
    status: row.status,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function fromModel(row: {
  publicId: string;
  weekStart: Date;
  timezoneSnapshot: string;
  summaryJson: unknown;
  reflection: string | null;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WeeklyReviewRecord {
  return toRecord({
    publicId: row.publicId,
    weekStart: row.weekStart,
    timezone: row.timezoneSnapshot,
    summary: row.summaryJson,
    reflection: row.reflection,
    status: row.status,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * WeeklyReviewRepositoryPort の Prisma 実装(docs/plans/weekly-review.md)。
 *
 * - すべての query が `user_id = actor` を条件に含み、単体操作は外部 ID(`public_id`)でのみ解決する
 *   (WREV-INV-001)。内部 PK は公開しない。
 * - 作成は `INSERT ... ON CONFLICT (user_id, week_start) DO NOTHING` の単一文(WREV-INV-002)。並行実行でも
 *   制約違反にならず、0 行なら既存を取得する。`created: true` を返すのは実際に挿入した 1 件のみ。
 * - 更新は `WHERE status = 'draft'` 付きの単一 `UPDATE`(WREV-INV-005)。確定済みを上書きせず、並行する
 *   確定は 1 件だけが成功する。0 行のときだけ存在確認で not_found/already_completed を判別する。
 * - raw SQL は `$queryRaw` のタグ付きテンプレート(バインド変数のみ)で、文字列連結をしない。
 * - `summary_json` は作成時のみ書き込み、更新しない(WREV-INV-004)。
 * - updated_at は DB の `set_updated_at` trigger が更新時に決める(docs/04-database-design.md)。
 */
export function createPrismaWeeklyReviewRepository(
  prisma: PrismaClient,
): WeeklyReviewRepositoryPort {
  async function findOwned(userId: bigint, reviewId: string): Promise<WeeklyReviewRecord | null> {
    const row = await prisma.weeklyReview.findFirst({ where: { userId, publicId: reviewId } });
    return row === null ? null : fromModel(row);
  }

  async function findByWeek(userId: bigint, weekStart: string): Promise<WeeklyReviewRecord | null> {
    const row = await prisma.weeklyReview.findFirst({
      where: { userId, weekStart: dateFromCalendarDate(weekStart) },
    });
    return row === null ? null : fromModel(row);
  }

  return {
    async findByWeekStart({ actorUserId, weekStart }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !CALENDAR_DATE_PATTERN.test(weekStart)) return null;
      return findByWeek(userId, weekStart);
    },

    async createIfAbsent({ actorUserId, weekStart, timezone, summary, now }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !CALENDAR_DATE_PATTERN.test(weekStart)) return null;

      const rows = await prisma.$queryRaw<ReviewRow[]>`
        INSERT INTO weekly_reviews
          (user_id, week_start, timezone_snapshot, summary_json, status, created_at, updated_at)
        SELECT u.id, ${dateFromCalendarDate(weekStart)}::date, ${timezone},
               ${JSON.stringify(summary)}::jsonb, 'draft', ${now}, ${now}
        FROM users u
        WHERE u.id = ${userId}
        ON CONFLICT (user_id, week_start) DO NOTHING
        RETURNING public_id::text AS public_id, week_start, timezone_snapshot, summary_json,
                  reflection, status, completed_at, created_at, updated_at`;

      const inserted = rows[0];
      if (inserted !== undefined) return { record: fromRawRow(inserted), created: true };

      // 0 行: 既に同じ週のレビューがある(並行作成の敗者を含む)か、actor の user が存在しない。
      const existing = await findByWeek(userId, weekStart);
      if (existing !== null) return { record: existing, created: false };
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (user === null) return null;
      // user はいるのに挿入も既存取得もできない(直後に削除された等)。内部エラーとして扱う。
      throw new Error("weekly review could not be created or found");
    },

    async findById({ actorUserId, reviewId }) {
      const userId = parseUserId(actorUserId);
      if (userId === null || !UUID_PATTERN.test(reviewId)) return null;
      return findOwned(userId, reviewId);
    },

    async list({ actorUserId, limit, beforeWeekStart }) {
      const userId = parseUserId(actorUserId);
      if (userId === null) return [];
      if (beforeWeekStart !== null && !CALENDAR_DATE_PATTERN.test(beforeWeekStart)) return [];

      const rows = await prisma.weeklyReview.findMany({
        where: {
          userId,
          ...(beforeWeekStart === null
            ? {}
            : { weekStart: { lt: dateFromCalendarDate(beforeWeekStart) } }),
        },
        orderBy: { weekStart: "desc" },
        take: limit,
      });
      return rows.map(fromModel);
    },

    async update({
      actorUserId,
      reviewId,
      reflection,
      complete,
      now,
    }): Promise<UpdateWeeklyReviewResult> {
      const userId = parseUserId(actorUserId);
      if (userId === null || !UUID_PATTERN.test(reviewId)) return { status: "not_found" };

      const setReflection = reflection !== undefined;
      const rows = await prisma.$queryRaw<ReviewRow[]>`
        UPDATE weekly_reviews
        SET reflection = CASE WHEN ${setReflection}::boolean THEN ${reflection ?? null}::text
                              ELSE reflection END,
            status = CASE WHEN ${complete}::boolean THEN 'completed' ELSE status END,
            completed_at = CASE WHEN ${complete}::boolean THEN ${now}::timestamptz
                                ELSE completed_at END
        WHERE public_id = ${reviewId}::uuid
          AND user_id = ${userId}
          AND status = 'draft'
        RETURNING public_id::text AS public_id, week_start, timezone_snapshot, summary_json,
                  reflection, status, completed_at, created_at, updated_at`;

      const updated = rows[0];
      if (updated !== undefined) return { status: "ok", record: fromRawRow(updated) };

      // 0 行: 存在しない・他人のレビュー、または確定済み。
      const current = await findOwned(userId, reviewId);
      if (current === null) return { status: "not_found" };
      if (current.status === "completed") return { status: "already_completed" };
      // draft なのに更新できなかった(確定は終端状態のため通常は起きない)。内部エラーとして扱う。
      throw new Error("weekly review update affected no rows");
    },
  };
}
