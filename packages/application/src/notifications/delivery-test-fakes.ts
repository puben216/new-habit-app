import { REMINDER_MAX_ATTEMPTS } from "@habit-app/domain";
import type { ReminderDeliveryStatus } from "@habit-app/domain";

import { ReminderEmailError } from "./delivery-ports";
import type {
  EmailSuppressionPort,
  ReminderDeliveryRecord,
  ReminderDeliveryRepositoryPort,
  ReminderEmail,
  ReminderEmailPort,
  ReminderQueuePort,
  ReminderScanSetting,
  UnsubscribeTokenPort,
} from "./delivery-ports";

/**
 * 配送 use case の Unit Test 専用 fake。永続化・transaction は持たず、use case のロジックと
 * port の契約(dedupe、claim、終端の不変)の再現のみを目的とする。
 */

export interface FakeDeliveryRow {
  id: string;
  setting: ReminderScanSetting;
  localDate: string;
  scheduledAt: Date;
  deduplicationKey: string;
  status: ReminderDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  enqueuedAt: Date | null;
  lockedUntil: Date | null;
  failureCode: string | null;
  providerMessageId: string | null;
}

export interface FakeDeliveryRepository extends ReminderDeliveryRepositoryPort {
  readonly rows: Map<string, FakeDeliveryRow>;
  /** テスト用: スケジューラが走査する有効な設定を投入する。 */
  setSettings(settings: readonly ReminderScanSetting[]): void;
  /** テスト用: pending の配送を直接投入する。 */
  seedPending(
    row: Partial<FakeDeliveryRow> & Pick<FakeDeliveryRow, "id" | "setting" | "scheduledAt">,
  ): FakeDeliveryRow;
}

export function createFakeDeliveryRepository(): FakeDeliveryRepository {
  const rows = new Map<string, FakeDeliveryRow>();
  let settings: readonly ReminderScanSetting[] = [];
  let nextId = 1;

  return {
    rows,
    setSettings(next) {
      settings = [...next].sort((a, b) => Number(BigInt(a.settingId) - BigInt(b.settingId)));
    },
    seedPending(partial) {
      const row: FakeDeliveryRow = {
        localDate: "2026-01-15",
        deduplicationKey: `seed:${partial.id}`,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: partial.scheduledAt,
        enqueuedAt: null,
        lockedUntil: null,
        failureCode: null,
        providerMessageId: null,
        ...partial,
      };
      rows.set(row.id, row);
      return row;
    },
    async listEnabledSettings({ afterSettingId, limit }) {
      return settings
        .filter((s) => afterSettingId === null || BigInt(s.settingId) > BigInt(afterSettingId))
        .slice(0, limit);
    },
    async createPendingIfAbsent({ setting, localDate, scheduledAt, deduplicationKey }) {
      for (const row of rows.values()) {
        if (row.deduplicationKey === deduplicationKey) return { created: false };
      }
      const id = String(nextId++);
      rows.set(id, {
        id,
        setting,
        localDate,
        scheduledAt,
        deduplicationKey,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: scheduledAt,
        enqueuedAt: null,
        lockedUntil: null,
        failureCode: null,
        providerMessageId: null,
      });
      return { created: true };
    },
    async failExhausted({ now }) {
      let count = 0;
      for (const row of rows.values()) {
        if (
          row.status === "pending" &&
          row.attemptCount >= REMINDER_MAX_ATTEMPTS &&
          (row.lockedUntil === null || row.lockedUntil <= now)
        ) {
          row.status = "failed";
          row.failureCode = "retries_exhausted";
          count += 1;
        }
      }
      return count;
    },
    async listEnqueueCandidates({ now, requeueBefore, limit }) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.status === "pending" &&
            row.nextAttemptAt <= now &&
            (row.enqueuedAt === null || row.enqueuedAt < requeueBefore),
        )
        .map((row) => row.id)
        .slice(0, limit);
    },
    async markEnqueued({ ids, now }) {
      for (const id of ids) {
        const row = rows.get(id);
        if (row !== undefined) row.enqueuedAt = now;
      }
    },
    async claim({ deliveryId, now, leaseUntil }) {
      const row = rows.get(deliveryId);
      if (
        row === undefined ||
        row.status !== "pending" ||
        row.nextAttemptAt > now ||
        (row.lockedUntil !== null && row.lockedUntil > now) ||
        row.attemptCount >= REMINDER_MAX_ATTEMPTS
      ) {
        return null;
      }
      row.attemptCount += 1;
      row.lockedUntil = leaseUntil;
      const record: ReminderDeliveryRecord = {
        id: row.id,
        userId: row.setting.userId,
        localDate: row.localDate,
        scheduledAt: row.scheduledAt,
        attemptCount: row.attemptCount,
      };
      return record;
    },
    async finalize({ deliveryId, status, failureCode, providerMessageId }) {
      const row = rows.get(deliveryId);
      if (row === undefined || row.status !== "pending") return false;
      row.status = status;
      row.failureCode = failureCode;
      row.providerMessageId = providerMessageId;
      row.lockedUntil = null;
      return true;
    },
    async scheduleRetry({ deliveryId, nextAttemptAt, failureCode }) {
      const row = rows.get(deliveryId);
      if (row === undefined || row.status !== "pending") return;
      row.nextAttemptAt = nextAttemptAt;
      row.failureCode = failureCode;
      row.lockedUntil = null;
      row.enqueuedAt = null;
    },
    async findUserIdByProviderMessageId(providerMessageId) {
      for (const row of rows.values()) {
        if (row.providerMessageId === providerMessageId) return row.setting.userId;
      }
      return null;
    },
  };
}

export interface FakeQueue extends ReminderQueuePort {
  readonly batches: (readonly string[])[];
  /** 次の enqueue で受け付けない ID(部分失敗の再現)。 */
  rejectIds: Set<string>;
  failAll: boolean;
}

export function createFakeQueue(): FakeQueue {
  const batches: (readonly string[])[] = [];
  const fake: FakeQueue = {
    batches,
    rejectIds: new Set(),
    failAll: false,
    async enqueue(ids) {
      if (fake.failAll) return [];
      const accepted = ids.filter((id) => !fake.rejectIds.has(id));
      if (accepted.length > 0) batches.push(accepted);
      return accepted;
    },
  };
  return fake;
}

export interface FakeEmailSender extends ReminderEmailPort {
  readonly sent: ReminderEmail[];
  /** 先頭から順に、投げる失敗(`null` は成功)。尽きたら成功する。 */
  script: (ReminderEmailError | Error | null)[];
}

export function createFakeEmailSender(): FakeEmailSender {
  const sent: ReminderEmail[] = [];
  const fake: FakeEmailSender = {
    sent,
    script: [],
    async send(email) {
      const step = fake.script.shift();
      if (step !== undefined && step !== null) throw step;
      sent.push(email);
      return { providerMessageId: `msg-${sent.length}` };
    },
  };
  return fake;
}

export interface FakeSuppressions extends EmailSuppressionPort {
  readonly users: Map<string, "bounce" | "complaint">;
}

export function createFakeSuppressions(): FakeSuppressions {
  const users = new Map<string, "bounce" | "complaint">();
  return {
    users,
    async isSuppressed(userId) {
      return users.has(userId);
    },
    async suppress({ userId, reason }) {
      if (!users.has(userId)) users.set(userId, reason);
    },
  };
}

/** `issue` は `fake.<公開 ID>`、`verify` はその形式のみ受理する(署名の検証は Infrastructure のテスト)。 */
export function createFakeUnsubscribeTokens(): UnsubscribeTokenPort {
  return {
    issue: (userPublicId) => `fake.${userPublicId}`,
    verify: (token) => (token.startsWith("fake.") ? token.slice(5) : null),
  };
}
