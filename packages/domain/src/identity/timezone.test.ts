import { describe, expect, it } from "vitest";
import { parseTimezone } from "./timezone";

describe("parseTimezone(PROF-004)", () => {
  it.each([
    "Asia/Tokyo",
    "America/New_York",
    "Europe/London",
    "UTC",
    "America/Argentina/Buenos_Aires",
    "Asia/Kathmandu",
    "Asia/Kolkata",
    "Australia/Lord_Howe",
    "Etc/GMT+9",
  ])("IANA ID %s は入力どおり許可する", (id) => {
    expect(parseTimezone(id)).toBe(id);
  });

  it.each([
    "",
    " ",
    " Asia/Tokyo",
    "Asia/Tokyo ",
    "asia/tokyo",
    "America/New_york",
    "utc",
    "JST",
    "EST",
    "GMT",
    "+09:00",
    "-05:00",
    "UTC+9",
    "Mars/Olympus",
    "Asia/",
    "/Asia/Tokyo",
    "Asia//Tokyo",
    "../etc/passwd",
    "a".repeat(65),
  ])("不正な値 %j は拒否する", (value) => {
    expect(parseTimezone(value)).toBeNull();
  });

  it("制御文字を含む値は拒否する", () => {
    expect(parseTimezone(`Asia/Tokyo${String.fromCodePoint(0)}`)).toBeNull();
    expect(parseTimezone(`Asia/Tokyo${String.fromCodePoint(10)}`)).toBeNull();
  });

  it("文字列以外は拒否する", () => {
    expect(parseTimezone(null)).toBeNull();
    expect(parseTimezone(9)).toBeNull();
    expect(parseTimezone(undefined)).toBeNull();
  });
});
