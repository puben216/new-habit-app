import { describe, expect, it, vi } from "vitest";

import { runAdminCli } from "./admin-cli";
import type { AdminCliDeps } from "./admin-cli";

function deps(overrides: Partial<AdminCliDeps> = {}): AdminCliDeps {
  return {
    grant: vi.fn(async () => ({
      status: "granted" as const,
      adminPublicId: "pub-1",
      otpauthUri: "otpauth://totp/x?secret=ABC",
      recoveryCodes: ["AAAAA-22222", "BBBBB-33333"],
    })),
    disable: vi.fn(async () => ({ status: "disabled" as const, adminPublicId: "pub-1" })),
    resetMfa: vi.fn(async () => ({
      status: "reset" as const,
      adminPublicId: "pub-1",
      otpauthUri: "otpauth://totp/x?secret=DEF",
      recoveryCodes: ["CCCCC-44444"],
    })),
    ...overrides,
  };
}

const text = (lines: readonly string[]) => lines.join("\n");

describe("runAdminCli", () => {
  it("grant: 使い捨ての登録情報（URI・リカバリーコード）を表示し、email は出力しない", async () => {
    const d = deps();
    const result = await runAdminCli(["grant", "--email", "admin@example.test"], d);
    expect(result.exitCode).toBe(0);
    expect(d.grant).toHaveBeenCalledWith("admin@example.test");
    const out = text(result.stdout);
    expect(out).toContain("otpauth://totp/x?secret=ABC");
    expect(out).toContain("AAAAA-22222");
    expect(out).toContain("一度だけ");
    expect(out).not.toContain("admin@example.test");
    expect(result.stderr).toEqual([]);
  });

  it("grant: 対象外・すでに有効は終了コード 1 で理由を表示（秘密は出さない）", async () => {
    const notEligible = await runAdminCli(
      ["grant", "--email", "x@example.test"],
      deps({ grant: async () => ({ status: "user_not_eligible" }) }),
    );
    expect(notEligible.exitCode).toBe(1);
    expect(text(notEligible.stderr)).toContain("見つかりません");
    expect(notEligible.stdout).toEqual([]);

    const already = await runAdminCli(
      ["grant", "--email", "x@example.test"],
      deps({ grant: async () => ({ status: "already_active" }) }),
    );
    expect(already.exitCode).toBe(1);
    expect(text(already.stderr)).toContain("admin:reset-mfa");
  });

  it("disable / reset-mfa: 成功は 0、対象なしは 1。reset-mfa は新しい登録情報を表示", async () => {
    const d = deps();
    const disabled = await runAdminCli(["disable", "--email", "a@example.test"], d);
    expect(disabled.exitCode).toBe(0);
    expect(text(disabled.stdout)).toContain("pub-1");

    const reset = await runAdminCli(["reset-mfa", "--email", "a@example.test"], d);
    expect(reset.exitCode).toBe(0);
    expect(text(reset.stdout)).toContain("CCCCC-44444");
    expect(text(reset.stdout)).not.toContain("a@example.test");

    const missing = deps({
      disable: async () => ({ status: "not_found" }),
      resetMfa: async () => ({ status: "not_found" }),
    });
    expect((await runAdminCli(["disable", "--email", "a@example.test"], missing)).exitCode).toBe(1);
    expect((await runAdminCli(["reset-mfa", "--email", "a@example.test"], missing)).exitCode).toBe(
      1,
    );
  });

  it("引数が不正なら use case を呼ばず、使い方を stderr に出して終了コード 2", async () => {
    for (const argv of [
      [],
      ["grant"],
      ["grant", "--email"],
      ["grant", "--email", "--force"],
      ["grant", "a@example.test"],
      ["grant", "--email", "a@example.test", "--extra"],
      ["grant", "--extra", "x", "--email", "a@example.test"],
      ["delete", "--email", "a@example.test"],
    ]) {
      const d = deps();
      const result = await runAdminCli(argv, d);
      expect(result.exitCode).toBe(2);
      expect(text(result.stderr)).toContain("使い方");
      expect(d.grant).not.toHaveBeenCalled();
      expect(d.disable).not.toHaveBeenCalled();
      expect(d.resetMfa).not.toHaveBeenCalled();
    }
  });
});
