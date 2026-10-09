import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PATHNAME_HEADER, withPathnameHeader } from "./pathname-header";

function source(pathname: string, search = "", headers: Record<string, string> = {}) {
  return { headers: new Headers(headers), nextUrl: { pathname, search } };
}

describe("withPathnameHeader", () => {
  it("path と query を x-pathname に載せ、他の header は保持する", () => {
    const headers = withPathnameHeader(source("/today", "?a=1", { cookie: "s=1" }));

    expect(headers.get(PATHNAME_HEADER)).toBe("/today?a=1");
    expect(headers.get("cookie")).toBe("s=1");
  });

  it("query がなければ path だけ", () => {
    expect(withPathnameHeader(source("/today")).get(PATHNAME_HEADER)).toBe("/today");
    expect(withPathnameHeader(source("/today", "?")).get(PATHNAME_HEADER)).toBe("/today");
  });

  it("client が送ってきた x-pathname は必ず上書きする", () => {
    const headers = withPathnameHeader(
      source("/today", "", { [PATHNAME_HEADER]: "//evil.example" }),
    );
    expect(headers.get(PATHNAME_HEADER)).toBe("/today");
  });

  it("RSC の内部 query(_rsc)は除くが、他の query は残す", () => {
    const headers = withPathnameHeader(source("/today", "?_rsc=abc&range=30"));
    expect(headers.get(PATHNAME_HEADER)).toBe("/today?range=30");
    expect(withPathnameHeader(source("/today", "?_rsc=abc")).get(PATHNAME_HEADER)).toBe("/today");
  });

  it("元の Headers を破壊しない", () => {
    const original = source("/today", "", { [PATHNAME_HEADER]: "/old" });
    withPathnameHeader(original);
    expect(original.headers.get(PATHNAME_HEADER)).toBe("/old");
  });

  it("性質: 任意の client 指定値に関わらず、結果は引数の path から決まる", () => {
    fc.assert(
      fc.property(fc.string(), (spoofed) => {
        let headers: Headers;
        try {
          headers = new Headers({ [PATHNAME_HEADER]: spoofed });
        } catch {
          return; // header 値として不正な文字列は client から届かない
        }
        const result = withPathnameHeader({
          headers,
          nextUrl: { pathname: "/habits", search: "" },
        });
        expect(result.get(PATHNAME_HEADER)).toBe("/habits");
      }),
    );
  });
});
