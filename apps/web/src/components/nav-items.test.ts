import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NAV_ITEMS, isCurrentPath } from "./nav-items";

describe("NAV_ITEMS", () => {
  it("href は '/' 始まりで重複せず、label は空でない", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});

describe("isCurrentPath", () => {
  it("同じ path と配下の path は一致し、前方一致だけの別 path は一致しない", () => {
    expect(isCurrentPath("/today", "/today")).toBe(true);
    expect(isCurrentPath("/today/edit", "/today")).toBe(true);
    expect(isCurrentPath("/todayx", "/today")).toBe(false);
    expect(isCurrentPath("/", "/today")).toBe(false);
    expect(isCurrentPath("/habits", "/today")).toBe(false);
  });

  it("性質: href の配下の任意の path は一致する", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9-]{1,10}$/),
        fc.stringMatching(/^[a-z0-9-]{1,10}$/),
        (a, b) => {
          expect(isCurrentPath(`/${a}/${b}`, `/${a}`)).toBe(true);
          expect(isCurrentPath(`/${a}${b}`, `/${a}`)).toBe(false);
        },
      ),
    );
  });
});
