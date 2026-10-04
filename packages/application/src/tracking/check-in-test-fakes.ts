import type { DailyCheckInRecord, DailyCheckInRepositoryPort } from "./check-in-ports";

/**
 * チェックイン use case の Unit Test 専用 fake。永続化・transaction は持たず、use case のロジックと
 * 「actor が必ず repository に渡される」ことの検証のみを目的とする。
 * `existingUserIds` に含まれない actor への upsert は `null` を返す。
 */
export interface FakeDailyCheckInRepository extends DailyCheckInRepositoryPort {
  readonly calls: readonly { readonly method: string; readonly actorUserId: string }[];
  readonly records: ReadonlyMap<string, DailyCheckInRecord>;
  /** テスト用: 記録を直接投入する(actor ごとの分離は key に user を含めて再現する)。 */
  seed(actorUserId: string, record: DailyCheckInRecord): void;
}

export function createFakeDailyCheckInRepository(
  existingUserIds: readonly string[],
): FakeDailyCheckInRepository {
  const users = new Set(existingUserIds);
  const store = new Map<string, DailyCheckInRecord>();
  const calls: { method: string; actorUserId: string }[] = [];
  const key = (actorUserId: string, date: string) => `${actorUserId}:${date}`;

  return {
    calls,
    records: store,
    seed(actorUserId, record) {
      store.set(key(actorUserId, record.date), record);
    },
    async find({ actorUserId, date }) {
      calls.push({ method: "find", actorUserId });
      return store.get(key(actorUserId, date)) ?? null;
    },
    async upsert({ actorUserId, date, mood, difficulty, note, now }) {
      calls.push({ method: "upsert", actorUserId });
      if (!users.has(actorUserId)) return null;
      const existing = store.get(key(actorUserId, date));
      const record: DailyCheckInRecord = {
        date,
        mood,
        difficulty,
        note,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      store.set(key(actorUserId, date), record);
      return record;
    },
  };
}
