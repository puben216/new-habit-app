import { isLocale, isWeekStartsOn } from "@habit-app/domain";
import type { ProfileRecord, ProfileRepositoryPort } from "@habit-app/application";
import { Prisma, type PrismaClient } from "../generated/prisma/client";

interface UserProfileRow {
  readonly userId: bigint;
  readonly displayName: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly weekStartsOn: number;
  readonly updatedAt: Date;
}

function toProfileRecord(row: UserProfileRow): ProfileRecord {
  // DB の CHECK 制約(T-102 migration)で保証される値域。破損時は黙って通さず失敗させる。
  if (!isLocale(row.locale) || !isWeekStartsOn(row.weekStartsOn)) {
    throw new Error("user_profiles contains a value outside the domain range");
  }
  return {
    userId: row.userId.toString(),
    displayName: row.displayName,
    timezone: row.timezone,
    locale: row.locale,
    weekStartsOn: row.weekStartsOn,
    updatedAt: row.updatedAt,
  };
}

/** actor の user ID(10 進文字列)を DB の bigint へ変換する。形式不正は「存在しない user」として扱う。 */
function toDbUserId(userId: string): bigint | null {
  return /^[0-9]{1,18}$/.test(userId) ? BigInt(userId) : null;
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/**
 * ProfileRepositoryPort 実装(docs/plans/user-profile.md)。user_profiles を使う。
 * すべての問い合わせは actor の user ID(`user_id` PK)を条件にする。
 */
export function createPrismaProfileRepository(prisma: PrismaClient): ProfileRepositoryPort {
  return {
    async ensure(userId, defaults) {
      const dbUserId = toDbUserId(userId);
      if (dbUserId === null) return null;

      try {
        // INSERT ... ON CONFLICT DO NOTHING。並行した初回アクセスでも 1 行のみ作成され例外にならない(PROF-INV-001)。
        await prisma.userProfile.createMany({
          data: [{ userId: dbUserId, ...defaults }],
          skipDuplicates: true,
        });
      } catch (error) {
        // user が存在しない(FK 違反)場合は null。
        if (hasPrismaErrorCode(error, "P2003")) return null;
        throw error;
      }

      const row = await prisma.userProfile.findUnique({ where: { userId: dbUserId } });
      return row === null ? null : toProfileRecord(row);
    },

    async update(userId, changes) {
      const dbUserId = toDbUserId(userId);
      if (dbUserId === null) return null;

      try {
        const row = await prisma.userProfile.update({
          where: { userId: dbUserId },
          data: { ...changes },
        });
        return toProfileRecord(row);
      } catch (error) {
        // 対象行が存在しない場合。
        if (hasPrismaErrorCode(error, "P2025")) return null;
        throw error;
      }
    },
  };
}
