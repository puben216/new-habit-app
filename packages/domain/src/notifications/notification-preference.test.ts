import { describe, expect, it } from "vitest";

import { InvalidNotificationPreferenceError, ReminderTimeInQuietHoursError } from "./errors";
import {
  DEFAULT_QUIET_HOURS,
  isLocalTime,
  isWithinQuietHours,
  resolveNotificationPreference,
} from "./notification-preference";

const TOKYO = "Asia/Tokyo";

describe("isLocalTime", () => {
  it.each(["00:00", "07:30", "23:59"])("%s は有効", (value) => {
    expect(isLocalTime(value)).toBe(true);
  });
  it.each(["24:00", "7:30", "07:60", "07:30:00", "0730", "", "ab:cd", " 07:30"])(
    "%j は無効",
    (value) => {
      expect(isLocalTime(value)).toBe(false);
    },
  );
  it("文字列以外は無効", () => {
    expect(isLocalTime(730)).toBe(false);
    expect(isLocalTime(null)).toBe(false);
  });
});

describe("isWithinQuietHours", () => {
  it.each([
    ["22:00", true],
    ["23:59", true],
    ["00:00", true],
    ["06:59", true],
    ["07:00", false],
    ["21:59", false],
    ["12:00", false],
  ])("日跨ぎ 22:00〜07:00: %s → %s", (time, expected) => {
    expect(isWithinQuietHours(time, DEFAULT_QUIET_HOURS)).toBe(expected);
  });

  it.each([
    ["01:00", true],
    ["04:59", true],
    ["05:00", false],
    ["00:59", false],
  ])("日跨ぎなし 01:00〜05:00: %s → %s", (time, expected) => {
    expect(isWithinQuietHours(time, { start: "01:00", end: "05:00" })).toBe(expected);
  });
});

describe("resolveNotificationPreference", () => {
  it("省略した quietHours は既定値、timezone はプロフィールの値になる", () => {
    expect(resolveNotificationPreference({ enabled: true, localTime: "07:30" }, TOKYO)).toEqual({
      enabled: true,
      localTime: "07:30",
      timezone: TOKYO,
      quietHours: { start: "22:00", end: "07:00" },
    });
  });

  it("quietHours: null は quiet hours なし。その場合は深夜の送信時刻も有効", () => {
    const result = resolveNotificationPreference(
      { enabled: true, localTime: "23:00", quietHours: null },
      TOKYO,
    );
    expect(result.quietHours).toBeNull();
  });

  it("timezone を明示するとプロフィールの値より優先される", () => {
    const result = resolveNotificationPreference(
      { enabled: true, localTime: "08:00", timezone: "America/New_York" },
      TOKYO,
    );
    expect(result.timezone).toBe("America/New_York");
  });

  it("有効で送信時刻が quiet hours 内なら拒否する。境界 07:00 は許可、22:00 は拒否", () => {
    expect(() =>
      resolveNotificationPreference({ enabled: true, localTime: "23:00" }, TOKYO),
    ).toThrow(ReminderTimeInQuietHoursError);
    expect(() =>
      resolveNotificationPreference({ enabled: true, localTime: "22:00" }, TOKYO),
    ).toThrow(ReminderTimeInQuietHoursError);
    expect(
      resolveNotificationPreference({ enabled: true, localTime: "07:00" }, TOKYO).localTime,
    ).toBe("07:00");
  });

  it("無効のときは送信時刻が quiet hours 内でも保存できる(停止は常に保存できる)", () => {
    const result = resolveNotificationPreference({ enabled: false, localTime: "23:00" }, TOKYO);
    expect(result.enabled).toBe(false);
    expect(result.localTime).toBe("23:00");
  });

  it.each(["24:00", "7:30", "07:30:00", ""])("不正な localTime %j を拒否する", (localTime) => {
    expect(() => resolveNotificationPreference({ enabled: false, localTime }, TOKYO)).toThrow(
      expect.objectContaining({ field: "localTime" }),
    );
  });

  it.each(["JST", "+09:00", "Mars/Olympus", "asia/tokyo"])(
    "不正な timezone %j を拒否する",
    (timezone) => {
      expect(() =>
        resolveNotificationPreference({ enabled: false, localTime: "08:00", timezone }, TOKYO),
      ).toThrow(expect.objectContaining({ field: "timezone" }));
    },
  );

  it("start と end が同じ quiet hours を拒否する", () => {
    expect(() =>
      resolveNotificationPreference(
        { enabled: false, localTime: "08:00", quietHours: { start: "22:00", end: "22:00" } },
        TOKYO,
      ),
    ).toThrow(InvalidNotificationPreferenceError);
  });

  it("形式不正な quiet hours を拒否する", () => {
    expect(() =>
      resolveNotificationPreference(
        { enabled: false, localTime: "08:00", quietHours: { start: "25:00", end: "07:00" } },
        TOKYO,
      ),
    ).toThrow(expect.objectContaining({ field: "quietHours" }));
  });
});
