import { describe, expect, it } from "vitest";

import { decideAdminGuard } from "./admin-guard";

describe("decideAdminGuard", () => {
  it("Admin でなければ、どの領域でも 404(存在の秘匿)", () => {
    expect(decideAdminGuard("not_admin", "shell")).toBe("not_found");
    expect(decideAdminGuard("not_admin", "verified")).toBe("not_found");
    expect(decideAdminGuard("not_admin", "mfa")).toBe("not_found");
  });

  it("共通 layout は Admin なら MFA の状態に関わらず描画する", () => {
    expect(decideAdminGuard("mfa_required", "shell")).toBe("render");
    expect(decideAdminGuard("granted", "shell")).toBe("render");
  });

  it("閲覧画面は MFA 検証済みのときだけ描画し、未検証は検証画面へ", () => {
    expect(decideAdminGuard("granted", "verified")).toBe("render");
    expect(decideAdminGuard("mfa_required", "verified")).toBe("redirect_mfa");
  });

  it("検証画面は未検証のときだけ描画し、検証済みなら戻す", () => {
    expect(decideAdminGuard("mfa_required", "mfa")).toBe("render");
    expect(decideAdminGuard("granted", "mfa")).toBe("redirect_home");
  });
});
