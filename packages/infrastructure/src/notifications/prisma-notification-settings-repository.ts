import type {
  NotificationSettingsRecord,
  NotificationSettingsRepositoryPort,
} from "@habit-app/application";
import { isLocalTime } from "@habit-app/domain";
import type { PrismaClient } from "../generated/prisma/client";
import { UUID_PATTERN } from "./shared";

const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** actor の user ID(session 由来の十進文字列)を bigint へ。形式不正は「何にも到達できない」扱い。 */
function parseUserId(actorUserId: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(actorUserId)) return null;
  const value = BigInt(actorUserId);
  return value <= MAX_BIGINT ? value : null;
}

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(): Error {
  return new Error("persisted notification settings violate invariants");
}

/**
 * `time` 列は Prisma の Date 変換(1970-01-01 起点の UTC)を介さず、SQL 側で `HH24:MI` の文字列にして
 * 読み書きする(時刻のずれを避けるため)。
 */
interface SettingsRow {
  enabled: boolean;
  local_time: string;
  timezone: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  updated_at: Date;
}

function toRecord(row: SettingsRow): NotificationSettingsRecord {
  if (!isLocalTime(row.local_time)) throw corrupted();
  const { quiet_hours_start: start, quiet_hours_end: end } = row;
  if (start === null && end === null) {
    return {
      enabled: row.enabled,
      localTime: row.local_time,
      timezone: row.timezone,
      quietHours: null,
      updatedAt: row.updated_at,
    };
  }
  if (start === null || end === null || !isLocalTime(start) || !isLocalTime(end)) {
    throw corrupted();
  }
  return {
    enabled: row.enabled,
    localTime: row.local_time,
    timezone: row.timezone,
    quietHours: { start, end },
    updatedAt: row.updated_at,
  };
}

/**
 * NotificationSettingsRepositoryPort の Prisma 実装(docs/plans/notification-preferences.md)。
 *
 * - すべての query が `user_id = actor` かつ `habit_id IS NULL`(ユーザー単位の設定)を条件に含む(NPF-INV-001)。
 * - upsert は `INSERT ... ON CONFLICT (user_id) WHERE habit_id IS NULL DO UPDATE` の単一文(NPF-INV-002。
 *   部分 unique index `notification_settings_user_default_uidx` が arbiter)。並行実行でも一意制約違反に
 *   ならず、後勝ちで 1 行に収束する。actor の user が存在しない場合は FK 違反ではなく、
 *   INSERT ... SELECT が 0 行になり `null` を返す。
 * - raw SQL は `$queryRaw` のタグ付きテンプレート(バインド変数のみ)で、文字列連結をしない。
 * - `enabled` と `channel` は常に明示して書く(DB 既定の `enabled = true` に依存しない。NPF-INV-003)。
 * - created_at は新規作成時のみ呼び出し側 Clock の値。更新時の updated_at は DB の
 *   `set_updated_at` trigger が決める(docs/04-database-design.md)。
 */
export function createPrismaNotificationSettingsRepository(
  prisma: PrismaClient,
): NotificationSettingsRepositoryPort {
  return {
    async find({ actorUserId }) {
      const userId = parseUserId(actorUserId);
      if (userId === null) return null;

      const rows = await prisma.$queryRaw<SettingsRow[]>`
        SELECT enabled,
               to_char(local_time, 'HH24:MI') AS local_time,
               timezone,
               to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
               to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
               updated_at
        FROM notification_settings
        WHERE user_id = ${userId} AND habit_id IS NULL`;
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async upsert({ actorUserId, enabled, localTime, timezone, quietHours, now }) {
      const userId = parseUserId(actorUserId);
      if (userId === null) return null;
      const quietStart = quietHours?.start ?? null;
      const quietEnd = quietHours?.end ?? null;

      const rows = await prisma.$queryRaw<SettingsRow[]>`
        INSERT INTO notification_settings
          (user_id, habit_id, channel, enabled, local_time, timezone,
           quiet_hours_start, quiet_hours_end, created_at, updated_at)
        SELECT u.id, NULL, 'email', ${enabled}, ${localTime}::time, ${timezone},
               ${quietStart}::time, ${quietEnd}::time, ${now}, ${now}
        FROM users u
        WHERE u.id = ${userId}
        ON CONFLICT (user_id) WHERE habit_id IS NULL DO UPDATE
          SET enabled = EXCLUDED.enabled,
              local_time = EXCLUDED.local_time,
              timezone = EXCLUDED.timezone,
              quiet_hours_start = EXCLUDED.quiet_hours_start,
              quiet_hours_end = EXCLUDED.quiet_hours_end,
              updated_at = EXCLUDED.updated_at
        RETURNING enabled,
                  to_char(local_time, 'HH24:MI') AS local_time,
                  timezone,
                  to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
                  to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
                  updated_at`;
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async disableByUserPublicId({ userPublicId }) {
      // 形式不正な ID は DB の uuid キャストでエラーになるため、先に弾く(何も起きない)。
      if (!UUID_PATTERN.test(userPublicId)) return;
      await prisma.$executeRaw`
        UPDATE notification_settings
        SET enabled = false
        WHERE habit_id IS NULL
          AND enabled
          AND user_id = (SELECT id FROM users WHERE public_id = ${userPublicId}::uuid)`;
    },
  };
}
