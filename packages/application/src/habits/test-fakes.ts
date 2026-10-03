import type {
  HabitRecord,
  HabitRepositoryPort,
  IdGeneratorPort,
  ListHabitsRepositoryResult,
  SaveHabitResult,
} from "./ports";

/**
 * habits use case の Unit Test 専用 fake。永続化・transaction は持たず、
 * use case のロジックと「actor が必ず repository に渡される」ことの検証のみを目的とする。
 */
export interface FakeHabitRepository extends HabitRepositoryPort {
  /** 呼び出し時の actorUserId の記録(HAPI-INV-001 の検証用)。 */
  readonly calls: readonly { readonly method: string; readonly actorUserId: string }[];
  /** 次の save を強制的に conflict にする(並行更新の再現)。 */
  forceConflictOnNextSave(): void;
}

interface StoredHabit {
  ownerId: string;
  seq: number;
  record: HabitRecord;
}

export function createFakeHabitRepository(): FakeHabitRepository {
  const store = new Map<string, StoredHabit>();
  const calls: { method: string; actorUserId: string }[] = [];
  let seq = 0;
  let conflictNext = false;

  function owned(actorUserId: string, habitId: string): StoredHabit | null {
    const stored = store.get(habitId);
    return stored !== undefined && stored.ownerId === actorUserId ? stored : null;
  }

  return {
    calls,
    forceConflictOnNextSave() {
      conflictNext = true;
    },
    async create({ actorUserId, habit, now }) {
      calls.push({ method: "create", actorUserId });
      seq += 1;
      const record: HabitRecord = { habit, version: 1, createdAt: now, updatedAt: now };
      store.set(habit.id, { ownerId: actorUserId, seq, record });
      return record;
    },
    async findById({ actorUserId, habitId }) {
      calls.push({ method: "findById", actorUserId });
      return owned(actorUserId, habitId)?.record ?? null;
    },
    async list({ actorUserId, status, limit, afterHabitId }): Promise<ListHabitsRepositoryResult> {
      calls.push({ method: "list", actorUserId });
      const mine = [...store.values()]
        .filter((s) => s.ownerId === actorUserId && s.record.habit.status === status)
        .sort((a, b) => b.seq - a.seq);
      let start = 0;
      if (afterHabitId !== null) {
        const index = mine.findIndex((s) => s.record.habit.id === afterHabitId);
        if (index < 0) return { ok: false, reason: "cursor_not_found" };
        start = index + 1;
      }
      return { ok: true, items: mine.slice(start, start + limit).map((s) => s.record) };
    },
    async save({ actorUserId, habit, expectedVersion, now }): Promise<SaveHabitResult> {
      calls.push({ method: "save", actorUserId });
      const stored = owned(actorUserId, habit.id);
      if (stored === null) return { status: "not_found" };
      if (conflictNext || stored.record.version !== expectedVersion) {
        conflictNext = false;
        return { status: "conflict" };
      }
      const record: HabitRecord = {
        habit,
        version: expectedVersion + 1,
        createdAt: stored.record.createdAt,
        updatedAt: now,
      };
      stored.record = record;
      return { status: "saved", record };
    },
  };
}

/** 連番の UUID 形式 ID を返す決定的な generator。 */
export function createSequentialIdGenerator(): IdGeneratorPort {
  let n = 0;
  return {
    generate() {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
  };
}
