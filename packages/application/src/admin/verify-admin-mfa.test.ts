import { describe, expect, it } from "vitest";

import { verifyAdminMfaUseCase } from "./verify-admin-mfa";
import {
  account,
  createFakeAdminCrypto,
  createFakeAdminRepository,
  createFakeAuditLog,
  createFakeSessionMfa,
} from "./test-fakes";

const NOW = new Date("2026-10-10T03:00:00.000Z");
const CONTEXT = { requestId: "req-1", ipHash: "iphash" };

function setup(overrides = {}, nowRef = { current: NOW }) {
  const adminRepository = createFakeAdminRepository([account(overrides)]);
  const sessionMfa = createFakeSessionMfa(["s1"]);
  const audit = createFakeAuditLog();
  const crypto = createFakeAdminCrypto();
  const run = (code: unknown, sessionId = "s1", actorUserId = "1") =>
    verifyAdminMfaUseCase(
      { adminRepository, sessionMfa, crypto, audit, now: () => nowRef.current },
      { actorUserId, sessionId, code, context: CONTEXT },
    );
  return { adminRepository, sessionMfa, audit, run, nowRef };
}

const actions = (audit: ReturnType<typeof createFakeAuditLog>) =>
  audit.entries.map((e) => e.action);

describe("verifyAdminMfaUseCase", () => {
  it("正しい TOTP で session を検証済みにし、監査に admin.mfa.verified を残す(コードは残さない)", async () => {
    const { run, sessionMfa, audit } = setup();
    expect(await run("123456")).toEqual({ status: "verified" });
    expect(sessionMfa.verified.get("s1")).toEqual(NOW);
    expect(actions(audit)).toEqual(["admin.mfa.verified"]);
    expect(audit.entries[0]).toMatchObject({
      actor: "admin:pub-admin-10",
      requestId: "req-1",
      ipHash: "iphash",
    });
    expect(JSON.stringify(audit.entries)).not.toContain("123456");
  });

  it("管理者でなければ not_admin(何も記録しない)", async () => {
    const { run, audit, sessionMfa } = setup();
    expect(await run("123456", "s1", "999")).toEqual({ status: "not_admin" });
    expect(audit.entries).toHaveLength(0);
    expect(sessionMfa.verified.size).toBe(0);
  });

  it("誤ったコード・形式不正は区別せず invalid。失敗を数えて監査に残し、session は検証済みにならない", async () => {
    const { run, sessionMfa, audit, adminRepository } = setup();
    // 上限(5 回)に達しない 4 回で、誤り・形式不正・型違いが同じ応答になることを確認する。
    for (const bad of ["000000", "12345", null, "ABCDE-22222"]) {
      expect(await run(bad)).toEqual({ status: "invalid" });
    }
    expect(sessionMfa.verified.size).toBe(0);
    expect(adminRepository.accounts.get("1")?.failedAttempts).toBeGreaterThan(0);
    expect(new Set(actions(audit))).toContain("admin.mfa.failed");
  });

  it("連続 5 回の失敗でロックされ、以後は正しいコードでも locked(コードを調べない)", async () => {
    const { run, adminRepository, audit } = setup();
    for (let i = 0; i < 4; i += 1) expect((await run("000000")).status).toBe("invalid");
    const fifth = await run("000000");
    expect(fifth).toMatchObject({ status: "locked", retryAfterSeconds: 900 });
    expect(actions(audit)).toContain("admin.mfa.locked");

    const calls = adminRepository.calls.length;
    const locked = await run("123456");
    expect(locked).toMatchObject({ status: "locked" });
    // ロック中は TOTP の成功も失敗も記録しない(コードの正否を調べない)。
    expect(adminRepository.calls.slice(calls)).toEqual(["findActiveByUserId"]);
  });

  it("ロック明けは正しいコードが受理され、失敗回数が 0 に戻る。ロック明けの失敗は 1 回目から数え直す", async () => {
    const nowRef = { current: NOW };
    const { run, adminRepository } = setup({}, nowRef);
    for (let i = 0; i < 5; i += 1) await run("000000");
    nowRef.current = new Date(NOW.getTime() + 15 * 60_000);
    expect(await run("123456")).toEqual({ status: "verified" });
    expect(adminRepository.accounts.get("1")).toMatchObject({
      failedAttempts: 0,
      lockedUntil: null,
    });

    const second = setup({}, { current: NOW });
    for (let i = 0; i < 5; i += 1) await second.run("000000");
    second.nowRef.current = new Date(NOW.getTime() + 16 * 60_000);
    expect((await second.run("000000")).status).toBe("invalid");
    expect(second.adminRepository.accounts.get("1")?.failedAttempts).toBe(1);
  });

  it("TOTP の同じコードの再利用(replay)は invalid", async () => {
    const { run } = setup();
    expect(await run("123456")).toEqual({ status: "verified" });
    expect(await run("123456")).toEqual({ status: "invalid" });
  });

  it("リカバリーコードは一度だけ受理され(大文字小文字・空白・ハイフンを無視)、使用を監査に残す", async () => {
    const { run, adminRepository, audit, sessionMfa } = setup();
    adminRepository.recoveryCodes.set("h:ABCDE-23456", { adminId: "10", used: false });
    expect(await run(" abcde 23456 ")).toEqual({ status: "verified" });
    expect(actions(audit)).toEqual(["admin.mfa.recovery_used"]);
    expect(sessionMfa.verified.has("s1")).toBe(true);
    expect(await run("ABCDE-23456")).toEqual({ status: "invalid" });
  });

  it("他の管理者のリカバリーコードは受理されない", async () => {
    const { run, adminRepository } = setup();
    adminRepository.recoveryCodes.set("h:ABCDE-23456", { adminId: "99", used: false });
    expect(await run("ABCDE-23456")).toEqual({ status: "invalid" });
  });

  it("session が存在しなければ invalid(検証済みにしない)", async () => {
    const { run, sessionMfa } = setup();
    expect(await run("123456", "missing")).toEqual({ status: "invalid" });
    expect(sessionMfa.verified.size).toBe(0);
  });

  it("他のユーザーの session ID が渡されても検証済みにならない（actor の session だけを対象にする）", async () => {
    const { run, sessionMfa } = setup();
    sessionMfa.sessions.set("other-session", "999");
    expect(await run("123456", "other-session")).toEqual({ status: "invalid" });
    expect(sessionMfa.verified.has("other-session")).toBe(false);
  });

  it("成功の監査に失敗したら session の検証を取り消して例外を投げる(fail closed)", async () => {
    const { run, sessionMfa, audit } = setup();
    audit.failing = true;
    await expect(run("123456")).rejects.toThrow("audit store unavailable");
    expect(sessionMfa.verified.has("s1")).toBe(false);
  });
});
