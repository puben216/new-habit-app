import { describe, expect, it } from "vitest";
import { InvalidScheduleCalculationInputError } from "./errors";
import { localDateAt } from "./local-date";

describe("localDateAt", () => {
  it("UTC と日付がずれる timezone でローカル暦日を返す", () => {
    expect(localDateAt(new Date("2026-01-31T15:00:00Z"), "Asia/Tokyo")).toBe("2026-02-01");
    expect(localDateAt(new Date("2026-01-31T14:59:59Z"), "Asia/Tokyo")).toBe("2026-01-31");
    expect(localDateAt(new Date("2026-01-01T00:00:00Z"), "America/Los_Angeles")).toBe("2025-12-31");
    expect(localDateAt(new Date("2026-01-01T00:00:00Z"), "UTC")).toBe("2026-01-01");
  });

  it("日付変更線に近い timezone で UTC と異なる暦日を返す", () => {
    // Pacific/Kiritimati は UTC+14、Pacific/Pago_Pago は UTC-11
    expect(localDateAt(new Date("2026-06-15T10:00:00Z"), "Pacific/Kiritimati")).toBe("2026-06-16");
    expect(localDateAt(new Date("2026-06-15T10:00:00Z"), "Pacific/Pago_Pago")).toBe("2026-06-14");
  });

  it("春の DST 切替日(23 時間日)の境界を壁時計の 0 時で判定する", () => {
    // America/New_York 2026-03-08: 02:00 EST -> 03:00 EDT。0 時は EST(UTC-5)、翌 0 時は EDT(UTC-4)
    expect(localDateAt(new Date("2026-03-08T04:59:59Z"), "America/New_York")).toBe("2026-03-07");
    expect(localDateAt(new Date("2026-03-08T05:00:00Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDateAt(new Date("2026-03-09T03:59:59Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDateAt(new Date("2026-03-09T04:00:00Z"), "America/New_York")).toBe("2026-03-09");
  });

  it("秋の DST 切替日(25 時間日)の境界を壁時計の 0 時で判定する", () => {
    // America/New_York 2026-11-01: 02:00 EDT -> 01:00 EST。0 時は EDT(UTC-4)、翌 0 時は EST(UTC-5)
    expect(localDateAt(new Date("2026-11-01T03:59:59Z"), "America/New_York")).toBe("2026-10-31");
    expect(localDateAt(new Date("2026-11-01T04:00:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateAt(new Date("2026-11-02T04:59:59Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateAt(new Date("2026-11-02T05:00:00Z"), "America/New_York")).toBe("2026-11-02");
  });

  it("うるう日を返す", () => {
    expect(localDateAt(new Date("2024-02-29T12:00:00Z"), "UTC")).toBe("2024-02-29");
  });

  it("不正な Date を拒否する", () => {
    expect(() => localDateAt(new Date(Number.NaN), "UTC")).toThrow(
      InvalidScheduleCalculationInputError,
    );
  });

  it("不正な timezone を拒否する", () => {
    expect(() => localDateAt(new Date("2026-01-01T00:00:00Z"), "Not/AZone")).toThrow(
      InvalidScheduleCalculationInputError,
    );
    expect(() => localDateAt(new Date("2026-01-01T00:00:00Z"), "")).toThrow(
      InvalidScheduleCalculationInputError,
    );
  });
});
