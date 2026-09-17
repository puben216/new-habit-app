import { describe, expect, it } from "vitest";
import { isTokenExpired } from "./token";

describe("isTokenExpired", () => {
  it("現在時刻がexpiresAtより前であればfalseを返す", () => {
    const expiresAt = new Date("2026-09-17T12:00:00Z");
    const now = new Date("2026-09-17T11:59:59Z");
    expect(isTokenExpired(expiresAt, now)).toBe(false);
  });

  it("現在時刻がexpiresAtと同時刻であればtrueを返す(境界値)", () => {
    const expiresAt = new Date("2026-09-17T12:00:00Z");
    const now = new Date("2026-09-17T12:00:00Z");
    expect(isTokenExpired(expiresAt, now)).toBe(true);
  });

  it("現在時刻がexpiresAtより後であればtrueを返す", () => {
    const expiresAt = new Date("2026-09-17T12:00:00Z");
    const now = new Date("2026-09-17T12:00:01Z");
    expect(isTokenExpired(expiresAt, now)).toBe(true);
  });
});
