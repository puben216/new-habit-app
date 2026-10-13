import type { AccountStatus } from "@habit-app/domain";

import type { LoginAttemptPort, LoginAttemptPurpose } from "../auth";
import type {
  AccountRepositoryPort,
  AccountRequestContext,
  ExternalDataCleanupPort,
  PurgeTarget,
} from "./ports";

/**
 * アカウント削除 use case の Unit Test 専用 fake。DB の条件付き更新・行ロック・transaction は持たず、
 * use case のロジックと、port が約束する意味(条件を満たすときだけ遷移する)の検証を目的とする。
 */
export interface FakeAccount {
  userId: string;
  publicId: string;
  emailNormalized: string;
  passwordHash: string;
  status: AccountStatus;
  deletedAt: Date | null;
  sessionCount: number;
}

export interface FakeAuditRow {
  readonly actor: string;
  readonly action: string;
  readonly targetPublicId: string;
  readonly requestId: string;
}

export interface FakeAccountRepository extends AccountRepositoryPort {
  readonly accounts: Map<string, FakeAccount>;
  readonly audit: FakeAuditRow[];
  /** `purge` が呼ばれた userId(呼び出しの検証用)。 */
  readonly purgeCalls: string[];
  /** 指定した userId の `purge` を失敗させる。 */
  failPurgeFor: Set<string>;
}

export function createFakeAccountRepository(
  accounts: readonly FakeAccount[],
): FakeAccountRepository {
  const store = new Map(accounts.map((account) => [account.userId, { ...account }]));
  const audit: FakeAuditRow[] = [];
  const purgeCalls: string[] = [];
  const failPurgeFor = new Set<string>();

  const record = (
    account: FakeAccount,
    actor: string,
    action: string,
    context: Pick<AccountRequestContext, "requestId">,
  ) =>
    audit.push({ actor, action, targetPublicId: account.publicId, requestId: context.requestId });

  return {
    accounts: store,
    audit,
    purgeCalls,
    failPurgeFor,

    async findForReauth(userId) {
      const account = store.get(userId);
      if (account === undefined) return null;
      return {
        emailNormalized: account.emailNormalized,
        passwordHash: account.passwordHash,
        status: account.status,
      };
    },

    async requestDeletion({ userId, now, context }) {
      const account = store.get(userId);
      if (account === undefined) return "not_found";
      if (account.status === "deletion_pending") return "already_requested";
      if (account.status !== "active") return "not_active";
      account.status = "deletion_pending";
      account.deletedAt = now;
      account.sessionCount = 0;
      record(account, `user:${account.publicId}`, "user.account.deletion_requested", context);
      return "requested";
    },

    async cancelDeletion({ userId, cutoff, context }) {
      const account = store.get(userId);
      if (account === undefined) return "not_found";
      if (account.status !== "deletion_pending" || account.deletedAt === null) {
        return "not_requested";
      }
      // 実装(SQL の `deleted_at > cutoff`)と同じ意味。cutoff 以前の要求は猶予期間が終わっている。
      if (account.deletedAt.getTime() <= cutoff.getTime()) return "expired";
      account.status = "active";
      account.deletedAt = null;
      record(account, `user:${account.publicId}`, "user.account.deletion_cancelled", context);
      return "cancelled";
    },

    async findDeletionState(userId) {
      const account = store.get(userId);
      return account === undefined
        ? null
        : { status: account.status, deletedAt: account.deletedAt };
    },

    async findDueForPurge({ cutoff, limit }) {
      return [...store.values()]
        .filter(
          (account) =>
            account.status === "deletion_pending" &&
            account.deletedAt !== null &&
            account.deletedAt.getTime() <= cutoff.getTime(),
        )
        .sort((a, b) => (a.deletedAt?.getTime() ?? 0) - (b.deletedAt?.getTime() ?? 0))
        .slice(0, limit)
        .map((account): PurgeTarget => ({
          userId: account.userId,
          userPublicId: account.publicId,
        }));
    },

    async purge({ userId, cutoff, requestId }) {
      purgeCalls.push(userId);
      if (failPurgeFor.has(userId)) throw new Error("simulated failure");
      const account = store.get(userId);
      if (
        account === undefined ||
        account.status !== "deletion_pending" ||
        account.deletedAt === null ||
        account.deletedAt.getTime() > cutoff.getTime()
      ) {
        return "skipped";
      }
      record(account, "system", "system.account.purged", { requestId });
      store.delete(userId);
      return "purged";
    },
  };
}

export interface FakeLoginAttempts extends LoginAttemptPort {
  readonly records: { purpose: LoginAttemptPurpose; email: string; succeeded: boolean }[];
}

/** 直近の失敗が `maxFailures` 回に達した (purpose, email) を blocked とする(時間窓は持たない)。 */
export function createFakeLoginAttempts(maxFailures = 5): FakeLoginAttempts {
  const records: FakeLoginAttempts["records"] = [];
  return {
    records,
    async record(purpose, email, succeeded) {
      records.push({ purpose, email, succeeded });
    },
    async isBlocked(purpose, email) {
      return (
        records.filter((r) => r.purpose === purpose && r.email === email && !r.succeeded).length >=
        maxFailures
      );
    },
    async pruneExpired() {},
  };
}

export interface FakeCleanup extends ExternalDataCleanupPort {
  readonly calls: PurgeTarget[];
  failFor: Set<string>;
}

export function createFakeCleanup(): FakeCleanup {
  const calls: PurgeTarget[] = [];
  const failFor = new Set<string>();
  return {
    calls,
    failFor,
    async cleanup(target) {
      calls.push(target);
      if (failFor.has(target.userId)) throw new Error("simulated cleanup failure");
    },
  };
}
