import type { WeeklyReviewRecord, WeeklyReviewRepositoryPort } from "./weekly-review-ports";

/**
 * 週次レビュー use case の Unit Test 専用 fake。永続化・transaction は持たず、use case のロジックと
 * 「actor が必ず repository に渡される」ことの検証のみを目的とする。
 * `existingUserIds` に含まれない actor への createIfAbsent は `null` を返す。
 */
export interface FakeWeeklyReviewRepository extends WeeklyReviewRepositoryPort {
  readonly calls: readonly { readonly method: string; readonly actorUserId: string }[];
  /** key は `${actorUserId}:${weekStart}`。 */
  readonly reviews: ReadonlyMap<string, WeeklyReviewRecord>;
  /** テスト用: レビューを直接投入する。 */
  seed(actorUserId: string, record: WeeklyReviewRecord): void;
}

export function createFakeWeeklyReviewRepository(
  existingUserIds: readonly string[],
): FakeWeeklyReviewRepository {
  const users = new Set(existingUserIds);
  const store = new Map<string, WeeklyReviewRecord>();
  const calls: { method: string; actorUserId: string }[] = [];
  const key = (actorUserId: string, weekStart: string) => `${actorUserId}:${weekStart}`;
  let sequence = 0;

  function ownedBy(actorUserId: string): WeeklyReviewRecord[] {
    return [...store.entries()]
      .filter(([k]) => k.startsWith(`${actorUserId}:`))
      .map(([, record]) => record);
  }

  return {
    calls,
    reviews: store,
    seed(actorUserId, record) {
      store.set(key(actorUserId, record.weekStart), record);
    },
    async findByWeekStart({ actorUserId, weekStart }) {
      calls.push({ method: "findByWeekStart", actorUserId });
      return store.get(key(actorUserId, weekStart)) ?? null;
    },
    async createIfAbsent({ actorUserId, weekStart, timezone, summary, now }) {
      calls.push({ method: "createIfAbsent", actorUserId });
      if (!users.has(actorUserId)) return null;
      const existing = store.get(key(actorUserId, weekStart));
      if (existing !== undefined) return { record: existing, created: false };
      sequence += 1;
      const record: WeeklyReviewRecord = {
        id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        weekStart,
        timezone,
        summary,
        reflection: null,
        status: "draft",
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      store.set(key(actorUserId, weekStart), record);
      return { record, created: true };
    },
    async findById({ actorUserId, reviewId }) {
      calls.push({ method: "findById", actorUserId });
      return ownedBy(actorUserId).find((record) => record.id === reviewId) ?? null;
    },
    async list({ actorUserId, limit, beforeWeekStart }) {
      calls.push({ method: "list", actorUserId });
      return ownedBy(actorUserId)
        .filter((record) => beforeWeekStart === null || record.weekStart < beforeWeekStart)
        .sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0))
        .slice(0, limit);
    },
    async update({ actorUserId, reviewId, reflection, complete, now }) {
      calls.push({ method: "update", actorUserId });
      const current = ownedBy(actorUserId).find((record) => record.id === reviewId);
      if (current === undefined) return { status: "not_found" };
      if (current.status === "completed") return { status: "already_completed" };
      const record: WeeklyReviewRecord = {
        ...current,
        reflection: reflection === undefined ? current.reflection : reflection,
        status: complete ? "completed" : "draft",
        completedAt: complete ? now : null,
        updatedAt: now,
      };
      store.set(key(actorUserId, current.weekStart), record);
      return { status: "ok", record };
    },
  };
}
