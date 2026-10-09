import type { NotificationSettingsRecord, NotificationSettingsRepositoryPort } from "./ports";

/**
 * 通知設定 use case の Unit Test 専用 fake。永続化・transaction は持たず、use case のロジックと
 * 「actor が必ず repository に渡される」ことの検証のみを目的とする。
 * `existingUserIds` に含まれない actor への upsert は `null` を返す。
 */
export interface FakeNotificationSettingsRepository extends NotificationSettingsRepositoryPort {
  readonly calls: readonly { readonly method: string; readonly actorUserId: string }[];
  readonly records: ReadonlyMap<string, NotificationSettingsRecord>;
  /** テスト用: 設定を直接投入する(actor ごとの分離を再現する)。 */
  seed(actorUserId: string, record: NotificationSettingsRecord): void;
}

export function createFakeNotificationSettingsRepository(
  existingUserIds: readonly string[],
  /** 公開 ID → 内部 user ID(配信停止リンクの検証用)。 */
  publicIds: Readonly<Record<string, string>> = {},
): FakeNotificationSettingsRepository {
  const users = new Set(existingUserIds);
  const store = new Map<string, NotificationSettingsRecord>();
  const calls: { method: string; actorUserId: string }[] = [];

  return {
    calls,
    records: store,
    seed(actorUserId, record) {
      store.set(actorUserId, record);
    },
    async find({ actorUserId }) {
      calls.push({ method: "find", actorUserId });
      return store.get(actorUserId) ?? null;
    },
    async upsert({ actorUserId, enabled, localTime, timezone, quietHours, now }) {
      calls.push({ method: "upsert", actorUserId });
      if (!users.has(actorUserId)) return null;
      const record: NotificationSettingsRecord = {
        enabled,
        localTime,
        timezone,
        quietHours,
        updatedAt: now,
      };
      store.set(actorUserId, record);
      return record;
    },
    async disableByUserPublicId({ userPublicId, now }) {
      const userId = publicIds[userPublicId];
      calls.push({ method: "disableByUserPublicId", actorUserId: userId ?? "" });
      const existing = userId === undefined ? undefined : store.get(userId);
      if (userId === undefined || existing === undefined || !existing.enabled) return;
      store.set(userId, { ...existing, enabled: false, updatedAt: now });
    },
  };
}
