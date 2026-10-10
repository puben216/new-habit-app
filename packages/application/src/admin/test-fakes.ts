import { REMINDER_DELIVERY_STATUSES } from "@habit-app/domain";

import type {
  AdminAccount,
  AdminAccountRepositoryPort,
  AdminCryptoPort,
  AdminProvisioningPort,
  AdminReadPort,
  AiJobFailureItem,
  AuditEntry,
  AuditLogPort,
  NotificationFailureItem,
  SessionMfaPort,
  UserOverviewRecord,
  UserSummary,
} from "./ports";

/** 管理機能の Unit Test 専用 fake。永続化の詳細は持たず、use case のロジックと port の契約だけを再現する。 */

export interface FakeAdminRepository extends AdminAccountRepositoryPort {
  readonly accounts: Map<string, AdminAccount>;
  readonly recoveryCodes: Map<string, { adminId: string; used: boolean }>;
  /** 呼び出しの履歴(原子性の検証用)。 */
  readonly calls: string[];
}

export function createFakeAdminRepository(
  accounts: readonly AdminAccount[] = [],
): FakeAdminRepository {
  const byUser = new Map(accounts.map((a) => [a.userId, a]));
  const recoveryCodes = new Map<string, { adminId: string; used: boolean }>();
  const calls: string[] = [];
  const byAdminId = (adminId: string) => [...byUser.values()].find((a) => a.adminId === adminId);

  function update(adminId: string, patch: Partial<AdminAccount>) {
    const account = byAdminId(adminId);
    if (account !== undefined) byUser.set(account.userId, { ...account, ...patch });
  }

  return {
    accounts: byUser,
    recoveryCodes,
    calls,
    async findActiveByUserId(userId) {
      calls.push("findActiveByUserId");
      return byUser.get(userId) ?? null;
    },
    async recordTotpSuccess({ adminId, step }) {
      calls.push("recordTotpSuccess");
      const account = byAdminId(adminId);
      if (account === undefined) return false;
      if (account.totpLastStep !== null && step <= account.totpLastStep) return false;
      update(adminId, { totpLastStep: step, failedAttempts: 0, lockedUntil: null });
      return true;
    },
    async consumeRecoveryCode({ adminId, codeHash }) {
      calls.push("consumeRecoveryCode");
      const entry = recoveryCodes.get(codeHash);
      if (entry === undefined || entry.adminId !== adminId || entry.used) return false;
      entry.used = true;
      update(adminId, { failedAttempts: 0, lockedUntil: null });
      return true;
    },
    async recordMfaFailure({ adminId, now, maxAttempts, lockoutMs }) {
      calls.push("recordMfaFailure");
      const account = byAdminId(adminId);
      if (account === undefined) return { locked: false, lockedUntil: null };
      const lockExpired = account.lockedUntil !== null && account.lockedUntil <= now;
      const attempts = (lockExpired ? 0 : account.failedAttempts) + 1;
      const lockedUntil =
        attempts >= maxAttempts
          ? new Date(now.getTime() + lockoutMs)
          : lockExpired
            ? null
            : account.lockedUntil;
      update(adminId, { failedAttempts: attempts, lockedUntil });
      return { locked: lockedUntil !== null && lockedUntil > now, lockedUntil };
    },
  };
}

export interface FakeSessionMfa extends SessionMfaPort {
  readonly verified: Map<string, Date>;
  /** 存在する session ID と、その所有者の user ID。 */
  readonly sessions: Map<string, string>;
}

/** `sessionIds` の session はすべて既定で user `1` のもの(`owners` で上書きできる)。 */
export function createFakeSessionMfa(
  sessionIds: readonly string[] = ["s1"],
  owners: Readonly<Record<string, string>> = {},
): FakeSessionMfa {
  const verified = new Map<string, Date>();
  const sessions = new Map(sessionIds.map((id) => [id, owners[id] ?? "1"]));
  return {
    verified,
    sessions,
    async markVerified({ sessionId, userId, now }) {
      if (sessions.get(sessionId) !== userId) return false;
      verified.set(sessionId, now);
      return true;
    },
    async clearVerified({ sessionId, userId }) {
      if (sessions.get(sessionId) === userId) verified.delete(sessionId);
    },
  };
}

export interface FakeAuditLog extends AuditLogPort {
  readonly entries: AuditEntry[];
  /** true の間、追記は例外になる。 */
  failing: boolean;
}

export function createFakeAuditLog(): FakeAuditLog {
  const entries: AuditEntry[] = [];
  const fake: FakeAuditLog = {
    entries,
    failing: false,
    async append(entry) {
      if (fake.failing) throw new Error("audit store unavailable");
      entries.push(entry);
    },
  };
  return fake;
}

/**
 * 決定論的な crypto の fake。TOTP は「現在のステップに対して 6 桁 `123456`」だけを受理する
 * (実際の RFC 6238 は infrastructure のテストで検証する)。リカバリーコードのハッシュは `h:<code>`。
 */
export function createFakeAdminCrypto(): AdminCryptoPort {
  let seq = 0;
  return {
    enrollTotp({ userId, accountLabel }) {
      return {
        encryptedSecret: `enc:${userId}`,
        otpauthUri: `otpauth://totp/test:${accountLabel}?secret=FAKE`,
      };
    },
    verifyTotp({ code, nowMs, lastStep }) {
      const step = Math.floor(nowMs / 30_000);
      if (code !== "123456") return null;
      if (lastStep !== null && step <= lastStep) return null;
      return step;
    },
    generateRecoveryCodes(count) {
      const codes = Array.from({ length: count }, () => {
        seq += 1;
        return `ABCDE-${String(seq).padStart(5, "2")}`;
      });
      return { codes, hashes: codes.map((c) => `h:${c}`) };
    },
    hashRecoveryCode: (code) => `h:${code}`,
  };
}

export interface FakeAdminRead extends AdminReadPort {
  readonly calls: string[];
  users: UserSummary[];
  overviews: Map<string, UserOverviewRecord>;
  notificationFailures: NotificationFailureItem[];
  aiJobFailures: AiJobFailureItem[];
}

export function createFakeAdminRead(): FakeAdminRead {
  const fake: FakeAdminRead = {
    calls: [],
    users: [],
    overviews: new Map(),
    notificationFailures: [],
    aiJobFailures: [],
    async findUserByEmail(emailNormalized) {
      fake.calls.push(`findUserByEmail:${emailNormalized}`);
      return fake.users.find((u) => u.email === emailNormalized) ?? null;
    },
    async getUserOverview({ publicId }) {
      fake.calls.push("getUserOverview");
      return fake.overviews.get(publicId) ?? null;
    },
    async listNotificationFailures({ statuses, limit, afterId }) {
      fake.calls.push("listNotificationFailures");
      return fake.notificationFailures
        .filter((i) => (statuses as readonly string[]).includes(i.status))
        .filter((i) => afterId === null || BigInt(i.id) < BigInt(afterId))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
        .slice(0, limit);
    },
    async listAiJobFailures({ statuses, limit, afterId }) {
      fake.calls.push("listAiJobFailures");
      return fake.aiJobFailures
        .filter((i) => (statuses as readonly string[]).includes(i.status))
        .filter((i) => afterId === null || BigInt(i.cursorId) < BigInt(afterId))
        .sort((a, b) => Number(BigInt(b.cursorId) - BigInt(a.cursorId)))
        .slice(0, limit);
    },
  };
  return fake;
}

export interface FakeProvisioning extends AdminProvisioningPort {
  readonly eligible: Map<string, string>;
  readonly admins: Map<
    string,
    {
      adminPublicId: string;
      status: "active" | "disabled";
      secret: string;
      hashes: readonly string[];
    }
  >;
  readonly sessionsRevoked: string[];
}

export function createFakeProvisioning(
  eligible: Readonly<Record<string, string>> = {},
): FakeProvisioning {
  const fake: FakeProvisioning = {
    eligible: new Map(Object.entries(eligible)),
    admins: new Map(),
    sessionsRevoked: [],
    async findEligibleUserByEmail(emailNormalized) {
      const userId = fake.eligible.get(emailNormalized);
      return userId === undefined ? null : { userId };
    },
    async grant({ userId, totpSecretEnc, recoveryCodeHashes }) {
      const existing = fake.admins.get(userId);
      if (existing?.status === "active") return { status: "already_active" };
      const adminPublicId = existing?.adminPublicId ?? `admin-pub-${userId}`;
      fake.admins.set(userId, {
        adminPublicId,
        status: "active",
        secret: totpSecretEnc,
        hashes: recoveryCodeHashes,
      });
      fake.sessionsRevoked.push(userId);
      return { status: "granted", adminPublicId };
    },
    async disable({ userId }) {
      const existing = fake.admins.get(userId);
      if (existing === undefined || existing.status !== "active") return null;
      fake.admins.set(userId, { ...existing, status: "disabled" });
      fake.sessionsRevoked.push(userId);
      return { adminPublicId: existing.adminPublicId };
    },
    async resetMfa({ userId, totpSecretEnc, recoveryCodeHashes }) {
      const existing = fake.admins.get(userId);
      if (existing === undefined || existing.status !== "active") return null;
      fake.admins.set(userId, { ...existing, secret: totpSecretEnc, hashes: recoveryCodeHashes });
      fake.sessionsRevoked.push(userId);
      return { adminPublicId: existing.adminPublicId };
    },
  };
  return fake;
}

/** テストで使う配送の状態(Domain の定義に追従させるための参照)。 */
export const KNOWN_DELIVERY_STATUSES = REMINDER_DELIVERY_STATUSES;

export function account(overrides: Partial<AdminAccount> = {}): AdminAccount {
  return {
    adminId: "10",
    adminPublicId: "pub-admin-10",
    userId: "1",
    totpSecretEnc: "enc:1",
    totpLastStep: null,
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}
