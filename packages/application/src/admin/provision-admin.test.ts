import { describe, expect, it } from "vitest";

import { disableAdminUseCase, grantAdminUseCase, resetAdminMfaUseCase } from "./provision-admin";
import type { ProvisionAdminDeps } from "./provision-admin";
import { createFakeAdminCrypto, createFakeAuditLog, createFakeProvisioning } from "./test-fakes";

const NOW = new Date("2026-10-10T03:00:00.000Z");

function setup() {
  const provisioning = createFakeProvisioning({ "admin@example.test": "7" });
  const audit = createFakeAuditLog();
  const deps: ProvisionAdminDeps = {
    provisioning,
    crypto: createFakeAdminCrypto(),
    audit,
    now: () => NOW,
    requestId: "cli-run-1",
  };
  return { provisioning, audit, deps };
}

describe("grantAdminUseCase", () => {
  it("確認済みの既存ユーザーを管理者にし、秘密とリカバリーコードを一度だけ返す。監査は operator", async () => {
    const { deps, provisioning, audit } = setup();
    const result = await grantAdminUseCase(deps, { email: " Admin@Example.test " });
    expect(result).toMatchObject({ status: "granted", adminPublicId: "admin-pub-7" });
    if (result.status !== "granted") return;
    expect(result.recoveryCodes).toHaveLength(8);
    expect(result.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // 保存されるのは暗号文とハッシュのみ(平文のコードは保存しない)。
    const stored = provisioning.admins.get("7");
    expect(stored?.secret).toBe("enc:7");
    expect(stored?.hashes).toEqual(result.recoveryCodes.map((c) => `h:${c}`));
    expect(stored?.hashes).not.toContain(result.recoveryCodes[0]);
    expect(audit.entries).toEqual([
      {
        actor: "operator",
        action: "operator.admin.granted",
        targetType: "admin",
        targetPublicId: "admin-pub-7",
        requestId: "cli-run-1",
        ipHash: "cli",
        now: NOW,
      },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain("example.test");
    expect(JSON.stringify(result)).not.toContain("example.test");
  });

  it("対象がいない・確認済みでないユーザーは user_not_eligible。すでに有効な管理者は already_active で何も変えない", async () => {
    const { deps, provisioning, audit } = setup();
    expect(await grantAdminUseCase(deps, { email: "nobody@example.test" })).toEqual({
      status: "user_not_eligible",
    });
    await grantAdminUseCase(deps, { email: "admin@example.test" });
    const before = provisioning.admins.get("7");
    expect(await grantAdminUseCase(deps, { email: "admin@example.test" })).toEqual({
      status: "already_active",
    });
    expect(provisioning.admins.get("7")).toEqual(before);
    expect(audit.entries).toHaveLength(1);
  });

  it("無効化された管理者は再有効化され、MFA が作り直される(session の MFA も無効化)", async () => {
    const { deps, provisioning } = setup();
    await grantAdminUseCase(deps, { email: "admin@example.test" });
    await disableAdminUseCase(deps, { email: "admin@example.test" });
    const again = await grantAdminUseCase(deps, { email: "admin@example.test" });
    expect(again).toMatchObject({ status: "granted", adminPublicId: "admin-pub-7" });
    expect(provisioning.admins.get("7")?.status).toBe("active");
    expect(provisioning.sessionsRevoked.length).toBeGreaterThanOrEqual(3);
  });

  it("監査に失敗したら例外(秘密は呼び出し側に返らない)", async () => {
    const { deps, audit } = setup();
    audit.failing = true;
    await expect(grantAdminUseCase(deps, { email: "admin@example.test" })).rejects.toThrow();
  });
});

describe("disableAdminUseCase / resetAdminMfaUseCase", () => {
  it("無効化は有効な管理者だけに働き、監査に残す。session の MFA を無効にする", async () => {
    const { deps, provisioning, audit } = setup();
    expect(await disableAdminUseCase(deps, { email: "admin@example.test" })).toEqual({
      status: "not_found",
    });
    await grantAdminUseCase(deps, { email: "admin@example.test" });
    expect(await disableAdminUseCase(deps, { email: "admin@example.test" })).toEqual({
      status: "disabled",
      adminPublicId: "admin-pub-7",
    });
    expect(provisioning.admins.get("7")?.status).toBe("disabled");
    expect(audit.entries.map((e) => e.action)).toEqual([
      "operator.admin.granted",
      "operator.admin.disabled",
    ]);
    // 2 回目は対象なし。
    expect((await disableAdminUseCase(deps, { email: "admin@example.test" })).status).toBe(
      "not_found",
    );
  });

  it("MFA の再発行は有効な管理者だけ。秘密とコードを作り直して返す", async () => {
    const { deps, provisioning } = setup();
    expect((await resetAdminMfaUseCase(deps, { email: "admin@example.test" })).status).toBe(
      "not_found",
    );
    const granted = await grantAdminUseCase(deps, { email: "admin@example.test" });
    const reset = await resetAdminMfaUseCase(deps, { email: "admin@example.test" });
    expect(reset.status).toBe("reset");
    if (granted.status !== "granted" || reset.status !== "reset") return;
    expect(reset.recoveryCodes).not.toEqual(granted.recoveryCodes);
    expect(provisioning.admins.get("7")?.hashes).toEqual(reset.recoveryCodes.map((c) => `h:${c}`));
  });
});
