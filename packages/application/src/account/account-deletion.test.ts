import fc from "fast-check";
import { ACCOUNT_DELETION_GRACE_DAYS, ACCOUNT_PURGE_BATCH_SIZE } from "@habit-app/domain";
import { describe, expect, it } from "vitest";

import { createFakePasswordHasher } from "../auth/test-fakes";
import {
  AccountNotActiveError,
  AccountNotFoundError,
  DeletionAlreadyRequestedError,
  DeletionNotRequestedError,
  GracePeriodExpiredError,
  ReauthenticationFailedError,
  TooManyAttemptsError,
} from "./errors";
import {
  createFakeAccountRepository,
  createFakeCleanup,
  createFakeLoginAttempts,
  type FakeAccount,
} from "./test-fakes";
import {
  cancelAccountDeletionUseCase,
  getAccountDeletionStatusUseCase,
  purgeExpiredAccountsUseCase,
  requestAccountDeletionUseCase,
} from "./use-cases";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T03:00:00.000Z");
const CONTEXT = { requestId: "req-1", ipHash: "hash" };
const PASSWORD = "correct horse battery staple";

const hasher = createFakePasswordHasher();

async function account(overrides: Partial<FakeAccount> = {}): Promise<FakeAccount> {
  return {
    userId: "1",
    publicId: "11111111-2222-4333-8444-555555555555",
    emailNormalized: "user@example.test",
    passwordHash: await hasher.hash(PASSWORD),
    status: "active",
    deletedAt: null,
    sessionCount: 3,
    ...overrides,
  };
}

async function setup(accounts: FakeAccount[] | undefined = undefined, now = NOW) {
  const list = accounts ?? [await account()];
  const repository = createFakeAccountRepository(list);
  const attempts = createFakeLoginAttempts();
  const cleanup = createFakeCleanup();
  const clock = () => now;
  return {
    repository,
    attempts,
    cleanup,
    request: (password: string, actorUserId = "1") =>
      requestAccountDeletionUseCase(
        { accounts: repository, passwordHasher: hasher, attempts, now: clock },
        { actorUserId, password, context: CONTEXT },
      ),
    cancel: (actorUserId = "1") =>
      cancelAccountDeletionUseCase(
        { accounts: repository, now: clock },
        { actorUserId, context: CONTEXT },
      ),
    status: (actorUserId = "1") =>
      getAccountDeletionStatusUseCase({ accounts: repository }, { actorUserId }),
    purge: () =>
      purgeExpiredAccountsUseCase({
        accounts: repository,
        cleanup,
        now: clock,
        newRequestId: () => "job-1",
      }),
  };
}

describe("requestAccountDeletionUseCase", () => {
  it("再認証に成功すると削除予約になり、30 日後の期限と session 失効・監査が返る", async () => {
    const { request, repository, attempts } = await setup();
    const result = await request(PASSWORD);
    expect(result).toEqual({
      status: "deletion_pending",
      scheduledFor: new Date(NOW.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS),
    });
    const stored = repository.accounts.get("1");
    expect(stored).toMatchObject({ status: "deletion_pending", deletedAt: NOW, sessionCount: 0 });
    expect(repository.audit).toEqual([
      {
        actor: "user:11111111-2222-4333-8444-555555555555",
        action: "user.account.deletion_requested",
        targetPublicId: "11111111-2222-4333-8444-555555555555",
        requestId: "req-1",
      },
    ]);
    // 成功も記録する(reauth 用)。
    expect(attempts.records).toEqual([
      { purpose: "reauth", email: "user@example.test", succeeded: true },
    ]);
  });

  it("パスワードが誤りなら拒否し、状態・session は変わらず、失敗を reauth として記録する", async () => {
    const { request, repository, attempts } = await setup();
    await expect(request("wrong")).rejects.toThrow(ReauthenticationFailedError);
    expect(repository.accounts.get("1")).toMatchObject({ status: "active", sessionCount: 3 });
    expect(repository.audit).toEqual([]);
    expect(attempts.records).toEqual([
      { purpose: "reauth", email: "user@example.test", succeeded: false },
    ]);
  });

  it("失敗が 5 回続くと、正しいパスワードでも検証せずに拒否する(以後は記録も増えない)", async () => {
    const { request, repository, attempts } = await setup();
    for (let i = 0; i < 5; i += 1) {
      await expect(request("wrong")).rejects.toThrow(ReauthenticationFailedError);
    }
    await expect(request(PASSWORD)).rejects.toThrow(TooManyAttemptsError);
    expect(repository.accounts.get("1")?.status).toBe("active");
    expect(attempts.records).toHaveLength(5);
  });

  it("制限は reauth だけで、通常のログイン(login)の記録に影響しない", async () => {
    const { request, attempts } = await setup();
    await attempts.record("login", "user@example.test", false);
    await request(PASSWORD);
    expect(attempts.records.filter((r) => r.purpose === "login")).toHaveLength(1);
    expect(attempts.records.filter((r) => r.purpose === "reauth")).toHaveLength(1);
  });

  it("user がいない・削除予約中・停止中は、それぞれ区別したエラー", async () => {
    const pending = await account({
      userId: "2",
      status: "deletion_pending",
      deletedAt: NOW,
      emailNormalized: "p@example.test",
    });
    const suspended = await account({
      userId: "3",
      status: "suspended",
      emailNormalized: "s@example.test",
    });
    const { request } = await setup([await account(), pending, suspended]);
    await expect(request(PASSWORD, "999")).rejects.toThrow(AccountNotFoundError);
    await expect(request(PASSWORD, "2")).rejects.toThrow(DeletionAlreadyRequestedError);
    await expect(request(PASSWORD, "3")).rejects.toThrow(AccountNotActiveError);
  });

  it("停止中は、パスワードの正誤にかかわらず先に判定され、パスワードの検証も試行の記録も行わない", async () => {
    const suspended = await account({ status: "suspended" });
    const { request, attempts } = await setup([suspended]);
    await expect(request("wrong")).rejects.toThrow(AccountNotActiveError);
    await expect(request(PASSWORD)).rejects.toThrow(AccountNotActiveError);
    expect(attempts.records).toEqual([]);
  });

  it("パスワードを結果・エラー・記録のどこにも含めない", async () => {
    const { request, repository, attempts } = await setup();
    const error = await request("secret-wrong-password").catch((e: unknown) => e);
    expect(JSON.stringify([String(error), repository.audit, attempts.records])).not.toContain(
      "secret-wrong-password",
    );
  });
});

describe("cancelAccountDeletionUseCase", () => {
  async function pendingSetup(requestedAt: Date, now: Date) {
    return setup(
      [await account({ status: "deletion_pending", deletedAt: requestedAt, sessionCount: 0 })],
      now,
    );
  }

  it("猶予期間内なら active に戻り、deleted_at が消えて監査が残る", async () => {
    const { cancel, repository } = await pendingSetup(NOW, new Date(NOW.getTime() + 10 * DAY_MS));
    await expect(cancel()).resolves.toEqual({ status: "active" });
    expect(repository.accounts.get("1")).toMatchObject({ status: "active", deletedAt: null });
    expect(repository.audit.map((row) => row.action)).toEqual(["user.account.deletion_cancelled"]);
  });

  it("期限の 1 ミリ秒前までは取り消せ、期限ちょうどからは取り消せない", async () => {
    const deadline = NOW.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS;
    const before = await pendingSetup(NOW, new Date(deadline - 1));
    await expect(before.cancel()).resolves.toEqual({ status: "active" });
    const at = await pendingSetup(NOW, new Date(deadline));
    await expect(at.cancel()).rejects.toThrow(GracePeriodExpiredError);
    expect(at.repository.accounts.get("1")?.status).toBe("deletion_pending");
  });

  it("active は DeletionNotRequestedError、user がいなければ AccountNotFoundError", async () => {
    const { cancel } = await setup();
    await expect(cancel()).rejects.toThrow(DeletionNotRequestedError);
    await expect(cancel("999")).rejects.toThrow(AccountNotFoundError);
  });
});

describe("getAccountDeletionStatusUseCase", () => {
  it("active は scheduledFor なし、予約中は期限を返す。停止中は active として返す", async () => {
    const pending = await account({
      userId: "2",
      status: "deletion_pending",
      deletedAt: NOW,
      emailNormalized: "p@example.test",
    });
    const suspended = await account({ userId: "3", status: "suspended", emailNormalized: "s@x.t" });
    const { status } = await setup([await account(), pending, suspended]);
    await expect(status("1")).resolves.toEqual({ status: "active", scheduledFor: null });
    await expect(status("2")).resolves.toEqual({
      status: "deletion_pending",
      scheduledFor: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    await expect(status("3")).resolves.toEqual({ status: "active", scheduledFor: null });
    await expect(status("999")).rejects.toThrow(AccountNotFoundError);
  });
});

describe("purgeExpiredAccountsUseCase", () => {
  const requestedAt = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY_MS);

  async function pending(userId: string, deletedAt: Date): Promise<FakeAccount> {
    return account({
      userId,
      publicId: `00000000-0000-4000-8000-${userId.padStart(12, "0")}`,
      emailNormalized: `${userId}@example.test`,
      status: "deletion_pending",
      deletedAt,
      sessionCount: 0,
    });
  }

  it("期限に達した予約だけを削除し、期限前・active は残す。境界は 30 日ちょうどから対象", async () => {
    const accounts = [
      await pending("1", requestedAt(30)),
      await pending("2", new Date(requestedAt(30).getTime() + 1)),
      await pending("3", requestedAt(45)),
      await account({ userId: "4", emailNormalized: "a@example.test" }),
    ];
    const { purge, repository, cleanup } = await setup(accounts);
    await expect(purge()).resolves.toEqual({ purged: 2, failed: 0, skipped: 0 });
    expect([...repository.accounts.keys()].sort()).toEqual(["2", "4"]);
    expect(cleanup.calls.map((c) => c.userId).sort()).toEqual(["1", "3"]);
    // 監査は公開 ID だけを対象にし、actor は system。
    expect(repository.audit).toHaveLength(2);
    for (const row of repository.audit) {
      expect(row.actor).toBe("system");
      expect(row.action).toBe("system.account.purged");
    }
  });

  it("片付けが失敗したユーザーは削除せず、他のユーザーの処理は続き、次回に再試行できる", async () => {
    const accounts = [await pending("1", requestedAt(40)), await pending("2", requestedAt(35))];
    const { purge, repository, cleanup } = await setup(accounts);
    cleanup.failFor.add("1");
    await expect(purge()).resolves.toEqual({ purged: 1, failed: 1, skipped: 0 });
    expect([...repository.accounts.keys()]).toEqual(["1"]);
    expect(repository.purgeCalls).toEqual(["2"]); // 失敗したユーザーは purge を呼ばない

    cleanup.failFor.clear();
    await expect(purge()).resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(repository.accounts.size).toBe(0);
  });

  it("purge が例外でも他のユーザーを処理し、件数だけを返す(識別子を含まない)", async () => {
    const accounts = [await pending("1", requestedAt(40)), await pending("2", requestedAt(35))];
    const { purge, repository } = await setup(accounts);
    repository.failPurgeFor.add("1");
    const summary = await purge();
    expect(summary).toEqual({ purged: 1, failed: 1, skipped: 0 });
    expect(JSON.stringify(summary)).not.toMatch(/example|0000/);
  });

  it("再実行しても何も起きない(冪等)", async () => {
    const { purge } = await setup([await pending("1", requestedAt(31))]);
    await purge();
    await expect(purge()).resolves.toEqual({ purged: 0, failed: 0, skipped: 0 });
  });

  it("1 回の実行は上限件数まで(古い順)", async () => {
    const accounts: FakeAccount[] = [];
    for (let i = 1; i <= ACCOUNT_PURGE_BATCH_SIZE + 5; i += 1) {
      accounts.push(await pending(String(i), requestedAt(31 + i)));
    }
    const { purge, repository } = await setup(accounts);
    const summary = await purge();
    expect(summary.purged).toBe(ACCOUNT_PURGE_BATCH_SIZE);
    expect(repository.accounts.size).toBe(5);
    // 残るのは最も新しい(deleted_at が遅い)5 件。
    expect([...repository.accounts.keys()].map(Number).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("性質: 経過日数が 30 日以上のものだけが削除され、それ未満は必ず残る", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 90 * 24 }), { minLength: 1, maxLength: 20 }),
        async (hours) => {
          const accounts = await Promise.all(
            hours.map((h, i) =>
              pending(String(i + 1), new Date(NOW.getTime() - h * 60 * 60 * 1000)),
            ),
          );
          const { purge, repository } = await setup(accounts);
          await purge();
          hours.forEach((h, i) => {
            const remains = repository.accounts.has(String(i + 1));
            expect(remains).toBe(h < 30 * 24);
          });
        },
      ),
      { numRuns: 50 },
    );
  });
});
