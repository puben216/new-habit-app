import { describe, expect, it } from "vitest";

import { InvalidNotificationPreferenceError } from "./errors";
import { localDateTimeAt, resolveReminderSlot } from "./zoned-time";

describe("resolveReminderSlot", () => {
  it("通常の日: Asia/Tokyo 08:00 は前日 23:00Z", () => {
    expect(resolveReminderSlot("2026-01-15", "08:00", "Asia/Tokyo").toISOString()).toBe(
      "2026-01-14T23:00:00.000Z",
    );
  });

  it("UTC はそのまま", () => {
    expect(resolveReminderSlot("2026-06-01", "12:34", "UTC").toISOString()).toBe(
      "2026-06-01T12:34:00.000Z",
    );
  });

  it("DST の gap(America/New_York 2026-03-08 02:30)は gap 直後の 03:00 EDT = 07:00Z", () => {
    expect(resolveReminderSlot("2026-03-08", "02:30", "America/New_York").toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    // gap の境界: 02:00 も存在しない、03:00 は存在する(EDT)。
    expect(resolveReminderSlot("2026-03-08", "02:00", "America/New_York").toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(resolveReminderSlot("2026-03-08", "03:00", "America/New_York").toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(resolveReminderSlot("2026-03-08", "01:59", "America/New_York").toISOString()).toBe(
      "2026-03-08T06:59:00.000Z",
    );
  });

  it("DST の fall-back(America/New_York 2026-11-01 01:30)は早い方の 05:30Z (EDT)", () => {
    expect(resolveReminderSlot("2026-11-01", "01:30", "America/New_York").toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    // 重複が終わった後の 02:00 EST は 07:00Z。
    expect(resolveReminderSlot("2026-11-01", "02:00", "America/New_York").toISOString()).toBe(
      "2026-11-01T07:00:00.000Z",
    );
  });

  it("30 分 DST の Australia/Lord_Howe でも gap を解決する", () => {
    // 2026-10-04 02:00 → 02:30 に進む(gap は 02:00〜02:29)。
    const slot = resolveReminderSlot("2026-10-04", "02:15", "Australia/Lord_Howe");
    expect(localDateTimeAt(slot, "Australia/Lord_Howe")).toEqual({
      date: "2026-10-04",
      time: "02:30",
    });
  });

  it("不正な日付・時刻を拒否する", () => {
    expect(() => resolveReminderSlot("2026-02-30", "08:00", "UTC")).toThrow(
      InvalidNotificationPreferenceError,
    );
    expect(() => resolveReminderSlot("2026-01-01", "8:00", "UTC")).toThrow(
      InvalidNotificationPreferenceError,
    );
  });
});

describe("localDateTimeAt", () => {
  it("日付境界をまたぐ", () => {
    expect(localDateTimeAt(new Date("2026-01-14T23:02:00Z"), "Asia/Tokyo")).toEqual({
      date: "2026-01-15",
      time: "08:02",
    });
    expect(localDateTimeAt(new Date("2026-01-15T00:00:00Z"), "UTC")).toEqual({
      date: "2026-01-15",
      time: "00:00",
    });
  });
});
