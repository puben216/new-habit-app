import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildLoginPath, parseNextPath, sanitizeNextPath } from "./next-path";

const hostile = [
  "//evil.example",
  "//evil.example/path",
  "///evil.example",
  "https://evil.example",
  "http://evil.example/today",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "\\\\evil.example",
  "/\\evil.example",
  "/\t/evil.example",
  "/\n/evil.example",
  "/ /evil.example",
  "/.//evil.example",
  "today",
  "habits",
  "habits/1",
  "",
  " /today",
  "/today\r\nSet-Cookie: x=1",
  "/api/v1/me",
  "/api",
  "/login",
  "/login?next=/today",
  "/signup",
  "/verify-email?token=abc",
  "/password-reset/confirm?token=abc",
];

describe("sanitizeNextPath", () => {
  it.each(hostile)("危険または不正な値は /today にする: %j", (value) => {
    expect(sanitizeNextPath(value)).toBe("/today");
  });

  it("undefined と空配列由来の値は /today", () => {
    expect(sanitizeNextPath(undefined)).toBe("/today");
    expect(sanitizeNextPath([])).toBe("/today");
  });

  it("配列で渡された場合は先頭だけを検証する", () => {
    expect(sanitizeNextPath(["/habits", "//evil.example"])).toBe("/habits");
    expect(sanitizeNextPath(["//evil.example", "/habits"])).toBe("/today");
  });

  it.each([
    ["/today", "/today"],
    ["/habits", "/habits"],
    ["/habits/abc-123", "/habits/abc-123"],
    ["/dashboard?range=30", "/dashboard?range=30"],
    ["/loginx", "/loginx"],
    ["/today#section", "/today"],
    // 正規化後も同一 origin の path に収まる(`..` は URL パーサーが解決する)。
    ["/%2F/evil.example/../..", "/"],
  ])("安全な path は正規化して通す: %s", (value, expected) => {
    expect(sanitizeNextPath(value)).toBe(expected);
  });

  it("長すぎる値は無視する", () => {
    expect(sanitizeNextPath(`/${"a".repeat(3000)}`)).toBe("/today");
  });

  it("性質: 任意の文字列に対して結果は常に安全な同一 origin の path である", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.webUrl()), (raw) => {
        const result = sanitizeNextPath(raw);
        expect(result.startsWith("/")).toBe(true);
        expect(result.startsWith("//")).toBe(false);
        expect(result).not.toMatch(/[\\\u0000- \u007f]/);
        expect(new URL(result, "http://app.test").origin).toBe("http://app.test");
        expect(result.startsWith("/api")).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("性質: 安全な path(許可 segment のみ)はそのまま通る", () => {
    const segment = fc
      .stringMatching(/^[a-z0-9-]{1,12}$/)
      .filter((s) => !["api", "login", "signup", "verify-email", "password-reset"].includes(s));
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (segments) => {
        const path = `/${segments.join("/")}`;
        expect(sanitizeNextPath(path)).toBe(path);
      }),
    );
  });

  it("性質: 冪等(sanitize の結果をもう一度通しても変わらない)", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = sanitizeNextPath(raw);
        expect(sanitizeNextPath(once)).toBe(once);
      }),
    );
  });
});

describe("parseNextPath", () => {
  it("不正は null、安全は path を返す(既定値と区別できる)", () => {
    expect(parseNextPath("//evil.example")).toBeNull();
    expect(parseNextPath("/today")).toBe("/today");
  });
});

describe("buildLoginPath", () => {
  it("next も reason もなければ /login", () => {
    expect(buildLoginPath()).toBe("/login");
    expect(buildLoginPath({ next: "//evil.example" })).toBe("/login");
  });

  it("安全な next をエンコードして載せる", () => {
    expect(buildLoginPath({ next: "/today" })).toBe("/login?next=%2Ftoday");
    expect(buildLoginPath({ next: "/dashboard?range=30" })).toBe(
      "/login?next=%2Fdashboard%3Frange%3D30",
    );
  });

  it("reason は session_expired 以外を載せない", () => {
    expect(buildLoginPath({ reason: "other" as never })).toBe("/login");
  });

  it("reason は session_expired のみ載せる", () => {
    expect(buildLoginPath({ next: "/today", reason: "session_expired" })).toBe(
      "/login?next=%2Ftoday&reason=session_expired",
    );
    expect(buildLoginPath({ reason: "session_expired" })).toBe("/login?reason=session_expired");
  });

  it("性質: 組み立てた next を読み戻すと元の安全な path になる", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\/[a-z0-9/-]{0,30}$/), (path) => {
        const built = buildLoginPath({ next: path });
        const parsed = new URL(built, "http://app.test").searchParams.get("next");
        if (parseNextPath(path) === null) {
          expect(parsed).toBeNull();
        } else {
          expect(sanitizeNextPath(parsed ?? undefined)).toBe(sanitizeNextPath(path));
        }
      }),
    );
  });
});
