import { describe, expect, it } from "vitest";

import { authorizeAdmin } from "./authorize-admin";
import { account, createFakeAdminRepository } from "./test-fakes";

const NOW = new Date("2026-10-10T03:00:00.000Z");
const minutes = (n: number) => n * 60_000;
const verifiedAgo = (ms: number) => new Date(NOW.getTime() - ms);

function setup(accounts = [account()]) {
  const adminRepository = createFakeAdminRepository(accounts);
  return {
    adminRepository,
    run: (input: Parameters<typeof authorizeAdmin>[1]) =>
      authorizeAdmin({ adminRepository, now: () => NOW }, input),
  };
}

describe("authorizeAdmin", () => {
  it("管理者でないユーザーは not_admin(MFA 検証済みでも)", async () => {
    const { run } = setup();
    expect(await run({ actorUserId: "999", mfaVerifiedAt: verifiedAgo(0) })).toEqual({
      status: "not_admin",
    });
  });

  it("管理者でも MFA が未検証なら mfa_required。管理者の識別子を返す", async () => {
    const { run } = setup();
    expect(await run({ actorUserId: "1", mfaVerifiedAt: null })).toEqual({
      status: "mfa_required",
      admin: { adminId: "10", adminPublicId: "pub-admin-10" },
    });
  });

  it("MFA 検証から 29 分は granted(有効期限つき)、30 分ちょうどは mfa_required", async () => {
    const { run } = setup();
    const ok = await run({ actorUserId: "1", mfaVerifiedAt: verifiedAgo(minutes(29)) });
    expect(ok).toMatchObject({ status: "granted", admin: { adminPublicId: "pub-admin-10" } });
    if (ok.status === "granted") {
      expect(ok.mfaExpiresAt.toISOString()).toBe(
        new Date(NOW.getTime() - minutes(29) + minutes(30)).toISOString(),
      );
    }
    expect((await run({ actorUserId: "1", mfaVerifiedAt: verifiedAgo(minutes(30)) })).status).toBe(
      "mfa_required",
    );
  });

  it("未来の MFA 検証時刻は mfa_required", async () => {
    const { run } = setup();
    expect(
      (await run({ actorUserId: "1", mfaVerifiedAt: new Date(NOW.getTime() + 1000) })).status,
    ).toBe("mfa_required");
  });

  it("判定は毎回 repository に問い合わせる(無効化が次のリクエストから効く)", async () => {
    const { run, adminRepository } = setup();
    expect((await run({ actorUserId: "1", mfaVerifiedAt: verifiedAgo(0) })).status).toBe("granted");
    adminRepository.accounts.delete("1"); // 無効化(findActiveByUserId が null を返す状態)
    expect((await run({ actorUserId: "1", mfaVerifiedAt: verifiedAgo(0) })).status).toBe(
      "not_admin",
    );
    expect(adminRepository.calls.filter((c) => c === "findActiveByUserId")).toHaveLength(2);
  });
});
