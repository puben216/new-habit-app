import type { ProfileChanges, UserProfile } from "@habit-app/domain";
import type { ProfileRecord, ProfileRepositoryPort } from "./ports";

/**
 * identity use case の Unit Test 専用 fake。永続化の詳細は持たず、use case のロジックのみを検証する。
 * `existingUserIds` に含まれない user は「存在しない user」として null を返す。
 */
export interface FakeProfileRepository extends ProfileRepositoryPort {
  readonly profiles: ReadonlyMap<string, ProfileRecord>;
  /** テスト用: 任意の record を直接投入する(他ユーザー行の再現用)。 */
  seed(record: ProfileRecord): void;
}

export function createFakeProfileRepository(
  existingUserIds: readonly string[],
  now: () => Date = () => new Date("2026-10-02T00:00:00.000Z"),
): FakeProfileRepository {
  const users = new Set(existingUserIds);
  const profiles = new Map<string, ProfileRecord>();

  return {
    profiles,

    seed(record) {
      users.add(record.userId);
      profiles.set(record.userId, record);
    },

    async ensure(userId, defaults: UserProfile) {
      if (!users.has(userId)) return null;
      const existing = profiles.get(userId);
      if (existing !== undefined) return existing;
      const created: ProfileRecord = { ...defaults, userId, updatedAt: now() };
      profiles.set(userId, created);
      return created;
    },

    async update(userId, changes: ProfileChanges) {
      const existing = profiles.get(userId);
      if (existing === undefined) return null;
      const updated: ProfileRecord = { ...existing, ...changes, updatedAt: now() };
      profiles.set(userId, updated);
      return updated;
    },
  };
}
