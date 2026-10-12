import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildAdminMfaPath, sanitizeAdminNextPath } from "./next-path";

const hostile = [
  "//evil.example",
  "https://evil.example/admin",
  "javascript:alert(1)",
  "\\\\evil.example",
  "/\\evil.example",
  "/.//evil.example",
  "/admin/../today",
  "admin",
  "",
  "/today",
  "/administrator",
  "/admin\r\nSet-Cookie: x=1",
  "/api/v1/admin/me",
  "/login?next=/admin",
];

describe("sanitizeAdminNextPath", () => {
  it("/admin 配下の path は query 付きでそのまま通す", () => {
    expect(sanitizeAdminNextPath("/admin")).toBe("/admin");
    expect(sanitizeAdminNextPath("/admin/users")).toBe("/admin/users");
    expect(sanitizeAdminNextPath("/admin/notifications?status=failed")).toBe(
      "/admin/notifications?status=failed",
    );
  });

  it.each(hostile)("危険または管理画面外の値 %j は /admin にする", (value) => {
    expect(sanitizeAdminNextPath(value)).toBe("/admin");
  });

  it("検証画面自身へは戻さない(循環の防止)", () => {
    expect(sanitizeAdminNextPath("/admin/mfa")).toBe("/admin");
    expect(sanitizeAdminNextPath("/admin/mfa?next=/admin/users")).toBe("/admin");
  });

  it("未指定・複数指定は /admin にする", () => {
    expect(sanitizeAdminNextPath(undefined)).toBe("/admin");
    expect(sanitizeAdminNextPath(["/admin/users", "/admin/ai-jobs"])).toBe("/admin/users");
  });

  it("性質: 結果は常に /admin 配下の同一 origin の path で、検証画面ではない", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (raw) => {
        const result = sanitizeAdminNextPath(raw);
        expect(result === "/admin" || result.startsWith("/admin/")).toBe(true);
        expect(result.startsWith("//")).toBe(false);
        expect(/^\/admin\/mfa(\/|\?|$)/.test(result)).toBe(false);
        // 冪等: 結果をもう一度通しても変わらない。
        expect(sanitizeAdminNextPath(result)).toBe(result);
      }),
      { numRuns: 500 },
    );
  });

  it("性質: /admin/<segment> の形は(検証画面を除き)そのまま保たれる", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9-]{1,12}$/), (segment) => {
        fc.pre(segment !== "mfa");
        expect(sanitizeAdminNextPath(`/admin/${segment}`)).toBe(`/admin/${segment}`);
      }),
    );
  });
});

describe("buildAdminMfaPath", () => {
  it("既定は next なし、/admin 配下だけを next に載せる", () => {
    expect(buildAdminMfaPath(undefined)).toBe("/admin/mfa");
    expect(buildAdminMfaPath("/admin")).toBe("/admin/mfa");
    expect(buildAdminMfaPath("/admin/users")).toBe("/admin/mfa?next=%2Fadmin%2Fusers");
    expect(buildAdminMfaPath("/admin/notifications?status=failed")).toBe(
      "/admin/mfa?next=%2Fadmin%2Fnotifications%3Fstatus%3Dfailed",
    );
  });

  it.each(hostile)("危険な next %j は載せない", (value) => {
    expect(buildAdminMfaPath(value)).toBe("/admin/mfa");
  });
});
