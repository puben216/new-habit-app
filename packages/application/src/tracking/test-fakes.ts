import type { HabitEntryRecord, HabitEntryRepositoryPort } from "./ports";

/**
 * tracking use case の Unit Test 専用 fake。永続化・transaction は持たず、use case のロジックと
 * 「actor が必ず repository に渡される」ことの検証のみを目的とする。
 * `ownedHabits`(呼び出し時点の内容を参照する。後から追加してよい)に含まれない (actor, habit) の組への upsert は `null` を返す(所有者限定の再現)。
 */
export interface FakeHabitEntryRepository extends HabitEntryRepositoryPort {
  readonly calls: readonly { readonly method: string; readonly actorUserId: string }[];
  readonly entries: ReadonlyMap<string, HabitEntryRecord>;
  /** テスト用: 記録を直接投入する(actor ごとの分離は key に user を含めて再現する)。 */
  seed(actorUserId: string, record: HabitEntryRecord): void;
}

export function createFakeHabitEntryRepository(
  ownedHabits: readonly { readonly actorUserId: string; readonly habitId: string }[],
): FakeHabitEntryRepository {
  const store = new Map<string, HabitEntryRecord>();
  const calls: { method: string; actorUserId: string }[] = [];
  const key = (actorUserId: string, habitId: string, date: string) =>
    `${actorUserId}:${habitId}:${date}`;

  return {
    calls,
    entries: store,
    seed(actorUserId, record) {
      store.set(key(actorUserId, record.habitId, record.date), record);
    },
    async upsert({ actorUserId, habitId, date, status, quantity, now }) {
      calls.push({ method: "upsert", actorUserId });
      if (!ownedHabits.some((h) => h.actorUserId === actorUserId && h.habitId === habitId)) {
        return null;
      }
      const k = key(actorUserId, habitId, date);
      const existing = store.get(k);
      const record: HabitEntryRecord = {
        habitId,
        date,
        status,
        quantity,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      store.set(k, record);
      return record;
    },
    async listByDate({ actorUserId, date }) {
      calls.push({ method: "listByDate", actorUserId });
      return [...store.entries()]
        .filter(([k]) => k.startsWith(`${actorUserId}:`) && k.endsWith(`:${date}`))
        .map(([, record]) => record);
    },
    async listByDateRange({ actorUserId, from, to }) {
      calls.push({ method: "listByDateRange", actorUserId });
      return [...store.entries()]
        .filter(
          ([k, record]) =>
            k.startsWith(`${actorUserId}:`) && record.date >= from && record.date <= to,
        )
        .map(([, record]) => record)
        .sort((a, b) => a.date.localeCompare(b.date));
    },
  };
}
