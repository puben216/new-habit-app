import type {
  ReminderDeliveryRecord,
  ReminderDeliveryRepositoryPort,
} from "@habit-app/application";
import { REMINDER_MAX_ATTEMPTS, isLocalTime } from "@habit-app/domain";
import type { PrismaClient } from "../generated/prisma/client";
import { calendarDateFromDate, dateFromCalendarDate, parseBigintId } from "./shared";

/** 保存済みの値が不変条件を満たさない(データ破損)場合の内部エラー。値や識別子を含めない。 */
function corrupted(): Error {
  return new Error("persisted notification delivery violates invariants");
}

/**
 * ReminderDeliveryRepositoryPort の Prisma 実装(docs/plans/notification-delivery.md)。
 *
 * - 状態を変える文はすべて単一の条件付き文(`WHERE status = 'pending'` など)で、読み取り後の更新をしない。
 *   そのため並行ワーカー・重複 message でも二重に claim/終端化されない(NDL-INV-002)。
 * - 配送の作成は `INSERT ... SELECT FROM notification_settings ... ON CONFLICT (deduplication_key) DO NOTHING`。
 *   走査後に設定が削除されても FK 違反にならず「作成しない」になる(NDL-INV-001)。
 * - raw SQL は `$queryRaw` / `$executeRaw` のタグ付きテンプレート(バインド変数のみ)で、文字列連結をしない。
 * - 列 `status` の値域は DB の CHECK と Domain の `ReminderDeliveryStatus` が同じ。
 */
export function createPrismaReminderDeliveryRepository(
  prisma: PrismaClient,
): ReminderDeliveryRepositoryPort {
  return {
    async listEnabledSettings({ afterSettingId, limit }) {
      const after = afterSettingId === null ? 0n : parseBigintId(afterSettingId);
      if (after === null) return [];
      const rows = await prisma.$queryRaw<
        { setting_id: string; user_id: string; local_time: string; timezone: string }[]
      >`
        SELECT id::text AS setting_id, user_id::text AS user_id,
               to_char(local_time, 'HH24:MI') AS local_time, timezone
        FROM notification_settings
        WHERE enabled AND habit_id IS NULL AND channel = 'email' AND id > ${after}
        ORDER BY id
        LIMIT ${limit}`;
      return rows.map((row) => {
        if (!isLocalTime(row.local_time)) throw corrupted();
        return {
          settingId: row.setting_id,
          userId: row.user_id,
          localTime: row.local_time,
          timezone: row.timezone,
        };
      });
    },

    async createPendingIfAbsent({ setting, localDate, scheduledAt, deduplicationKey, now }) {
      const settingId = parseBigintId(setting.settingId);
      if (settingId === null) return { created: false };
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO notification_deliveries
          (notification_setting_id, user_id, local_date, scheduled_at, deduplication_key,
           status, attempt_count, next_attempt_at, created_at, updated_at)
        SELECT s.id, s.user_id, ${dateFromCalendarDate(localDate)}::date, ${scheduledAt},
               ${deduplicationKey}, 'pending', 0, ${scheduledAt}, ${now}, ${now}
        FROM notification_settings s
        WHERE s.id = ${settingId}
        ON CONFLICT (deduplication_key) DO NOTHING
        RETURNING id::text AS id`;
      return { created: rows.length > 0 };
    },

    async failExhausted({ now }) {
      return prisma.$executeRaw`
        UPDATE notification_deliveries
        SET status = 'failed', failure_code = 'retries_exhausted', locked_until = NULL
        WHERE status = 'pending'
          AND attempt_count >= ${REMINDER_MAX_ATTEMPTS}
          AND (locked_until IS NULL OR locked_until <= ${now})`;
    },

    async listEnqueueCandidates({ now, requeueBefore, limit }) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id
        FROM notification_deliveries
        WHERE status = 'pending'
          AND next_attempt_at <= ${now}
          AND (enqueued_at IS NULL OR enqueued_at < ${requeueBefore})
        ORDER BY id
        LIMIT ${limit}`;
      return rows.map((row) => row.id);
    },

    async markEnqueued({ ids, now }) {
      const parsed = ids.map(parseBigintId).filter((id): id is bigint => id !== null);
      if (parsed.length === 0) return;
      await prisma.$executeRaw`
        UPDATE notification_deliveries
        SET enqueued_at = ${now}
        WHERE id = ANY(${parsed}::bigint[]) AND status = 'pending'`;
    },

    async claim({ deliveryId, now, leaseUntil }) {
      const id = parseBigintId(deliveryId);
      if (id === null) return null;
      const rows = await prisma.$queryRaw<
        {
          id: string;
          user_id: string;
          local_date: Date;
          scheduled_at: Date;
          attempt_count: number;
        }[]
      >`
        UPDATE notification_deliveries
        SET attempt_count = attempt_count + 1, locked_until = ${leaseUntil}
        WHERE id = ${id}
          AND status = 'pending'
          AND next_attempt_at <= ${now}
          AND (locked_until IS NULL OR locked_until <= ${now})
          AND attempt_count < ${REMINDER_MAX_ATTEMPTS}
        RETURNING id::text AS id, user_id::text AS user_id, local_date, scheduled_at, attempt_count`;
      const row = rows[0];
      if (row === undefined) return null;
      const record: ReminderDeliveryRecord = {
        id: row.id,
        userId: row.user_id,
        localDate: calendarDateFromDate(row.local_date),
        scheduledAt: row.scheduled_at,
        attemptCount: row.attempt_count,
      };
      return record;
    },

    async finalize({ deliveryId, status, failureCode, providerMessageId, now }) {
      const id = parseBigintId(deliveryId);
      if (id === null) return false;
      const sentAt = status === "sent" ? now : null;
      const updated = await prisma.$executeRaw`
        UPDATE notification_deliveries
        SET status = ${status}, failure_code = ${failureCode},
            provider_message_id = ${providerMessageId}, sent_at = ${sentAt}, locked_until = NULL
        WHERE id = ${id} AND status = 'pending'`;
      return updated > 0;
    },

    async scheduleRetry({ deliveryId, nextAttemptAt, failureCode }) {
      const id = parseBigintId(deliveryId);
      if (id === null) return;
      await prisma.$executeRaw`
        UPDATE notification_deliveries
        SET next_attempt_at = ${nextAttemptAt}, failure_code = ${failureCode},
            locked_until = NULL, enqueued_at = NULL
        WHERE id = ${id} AND status = 'pending'`;
    },

    async findUserIdByProviderMessageId(providerMessageId) {
      const rows = await prisma.$queryRaw<{ user_id: string }[]>`
        SELECT user_id::text AS user_id
        FROM notification_deliveries
        WHERE provider_message_id = ${providerMessageId}`;
      return rows[0]?.user_id ?? null;
    },
  };
}
