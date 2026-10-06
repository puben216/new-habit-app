import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isSafeApiPath } from "./api-path";

const safeSegment = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,15}$/);

describe("isSafeApiPath", () => {
  it.each([
    "/api/v1/habits",
    "/api/v1/habits/abc-123/entries/2026-10-06",
    "/api/v1/habits?limit=20&cursor=a%3Db",
    "/api/v1/schedule/today",
  ])("許可する: %s", (path) => {
    expect(isSafeApiPath(path)).toBe(true);
  });

  it.each([
    "https://evil.example/api/v1/x",
    "//evil.example/api/v1/x",
    "/api/v1/",
    "/api/v2/habits",
    "/api/auth/session",
    "api/v1/habits",
    "/api/v1/../auth/session",
    "/api/v1/habits/%2e%2e/x",
    "/api/v1/habits/%2E%2E/x",
    "/api/v1/habits/./x",
    "/api/v1/habits//x",
    "/api/v1/habits/%2Fetc",
    "/api/v1/habits/%5Cx",
    "/api/v1/habits/%zz",
    "/api/v1/habits x",
    "/api/v1/habits\n",
    "/api/v1/habits#fragment",
    "/api/v1/habits\\x",
    "",
  ])("拒否する: %j", (path) => {
    expect(isSafeApiPath(path)).toBe(false);
  });

  it("性質: 安全な segment だけで構成した /api/v1/ 配下の path はすべて許可する", () => {
    fc.assert(
      fc.property(fc.array(safeSegment, { minLength: 1, maxLength: 5 }), (segments) => {
        expect(isSafeApiPath(`/api/v1/${segments.join("/")}`)).toBe(true);
      }),
    );
  });

  it("性質: /api/v1/ で始まらない文字列はすべて拒否する", () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => !value.startsWith("/api/v1/")),
        (value) => {
          expect(isSafeApiPath(value)).toBe(false);
        },
      ),
    );
  });

  it("性質: 任意の位置に . または .. の segment(エンコード有無を問わない)を含むと拒否する", () => {
    const dots = fc.constantFrom(".", "..", "%2e", "%2e%2e", "%2E%2E", ".%2e");
    fc.assert(
      fc.property(
        fc.array(safeSegment, { maxLength: 3 }),
        dots,
        fc.array(safeSegment, { maxLength: 3 }),
        (before, dot, after) => {
          const path = `/api/v1/${[...before, dot, ...after].join("/")}`;
          expect(isSafeApiPath(path)).toBe(false);
        },
      ),
    );
  });
});
