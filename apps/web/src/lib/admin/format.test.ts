import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatUtc, sortedCounts, statusLabel } from "./format";

describe("formatUtc", () => {
  it("UTC の固定書式にする(端末の timezone に依存しない)", () => {
    expect(formatUtc("2026-10-09T03:04:05.678Z")).toBe("2026-10-09 03:04 UTC");
    expect(formatUtc("2026-10-09T23:59:59.999Z")).toBe("2026-10-09 23:59 UTC");
  });

  it("オフセット付きの値も UTC に直す", () => {
    expect(formatUtc("2026-10-09T09:00:00+09:00")).toBe("2026-10-09 00:00 UTC");
  });

  it("不正な値は元の文字列を出さず「不明」にする", () => {
    expect(formatUtc("not a date")).toBe("不明");
    expect(formatUtc("")).toBe("不明");
  });

  it("性質: 有効な時刻は常に YYYY-MM-DD HH:mm UTC で、同じ分なら同じ表示になる", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2100-01-01T00:00:00Z") }),
        (date) => {
          const text = formatUtc(date.toISOString());
          expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
          const sameMinute = new Date(Math.floor(date.getTime() / 60_000) * 60_000);
          expect(formatUtc(sameMinute.toISOString())).toBe(text);
        },
      ),
    );
  });
});

describe("statusLabel", () => {
  it("既知のコードは日本語、未知のコードはそのまま返す", () => {
    expect(statusLabel("failed")).toBe("失敗");
    expect(statusLabel("expired")).toBe("期限切れ");
    expect(statusLabel("suppressed")).toBe("配信停止");
    expect(statusLabel("fallback")).toBe("フォールバック");
    expect(statusLabel("something_new")).toBe("something_new");
  });
});

describe("sortedCounts", () => {
  it("コード順に並べ、件数を保つ", () => {
    expect(sortedCounts({ sent: 5, failed: 2 })).toEqual([
      ["failed", 2],
      ["sent", 5],
    ]);
    expect(sortedCounts({})).toEqual([]);
  });
});
