import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseFailureStatus } from "./failure-status";

describe("parseFailureStatus", () => {
  it("一覧ごとに許可された状態だけを通す", () => {
    expect(parseFailureStatus("notification", "failed")).toBe("failed");
    expect(parseFailureStatus("notification", "expired")).toBe("expired");
    expect(parseFailureStatus("notification", "suppressed")).toBe("suppressed");
    expect(parseFailureStatus("ai", "failed")).toBe("failed");
    expect(parseFailureStatus("ai", "fallback")).toBe("fallback");
  });

  it("別の一覧の状態・未知の値・複数指定・未指定は「すべて」にする", () => {
    expect(parseFailureStatus("notification", "fallback")).toBeUndefined();
    expect(parseFailureStatus("ai", "expired")).toBeUndefined();
    expect(parseFailureStatus("ai", "<script>")).toBeUndefined();
    expect(parseFailureStatus("notification", ["failed", "expired"])).toBeUndefined();
    expect(parseFailureStatus("notification", undefined)).toBeUndefined();
  });

  it("性質: 結果は未指定か許可された値のどちらかで、入力の一部を加工して返さない", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (raw) => {
        const result = parseFailureStatus("notification", raw);
        expect(result === undefined || result === raw).toBe(true);
        if (result !== undefined) expect(["failed", "expired", "suppressed"]).toContain(result);
      }),
    );
  });
});
