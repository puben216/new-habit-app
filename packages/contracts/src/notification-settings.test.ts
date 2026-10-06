import { describe, expect, it } from "vitest";

import {
  notificationSettingsResponseSchema,
  upsertNotificationSettingsRequestSchema,
} from "./notification-settings";

const parse = (body: unknown) => upsertNotificationSettingsRequestSchema.safeParse(body);

describe("upsertNotificationSettingsRequestSchema", () => {
  it("enabled と localTime だけで受理する。quietHours は省略・null・値のいずれも可", () => {
    expect(parse({ enabled: true, localTime: "07:30" }).success).toBe(true);
    expect(parse({ enabled: true, localTime: "07:30", quietHours: null }).success).toBe(true);
    expect(
      parse({ enabled: false, localTime: "00:00", quietHours: { start: "22:00", end: "07:00" } })
        .success,
    ).toBe(true);
  });

  it.each(["24:00", "7:30", "07:60", "07:30:00", "", "0730"])(
    "localTime %j を拒否する",
    (value) => {
      expect(parse({ enabled: true, localTime: value }).success).toBe(false);
    },
  );

  it("必須項目の欠落と型違いを拒否する", () => {
    expect(parse({ localTime: "07:30" }).success).toBe(false);
    expect(parse({ enabled: true }).success).toBe(false);
    expect(parse({ enabled: "true", localTime: "07:30" }).success).toBe(false);
  });

  it("quietHours の形式違い・未知キーを拒否する", () => {
    const base = { enabled: true, localTime: "07:30" };
    expect(parse({ ...base, quietHours: { start: "22:00" } }).success).toBe(false);
    expect(parse({ ...base, quietHours: { start: "22:00", end: "7:00" } }).success).toBe(false);
    expect(parse({ ...base, quietHours: { start: "22:00", end: "07:00", extra: 1 } }).success).toBe(
      false,
    );
  });

  it.each(["userId", "habitId", "channel", "email"])("未知キー %s を拒否する", (key) => {
    expect(parse({ enabled: true, localTime: "07:30", [key]: "x" }).success).toBe(false);
  });

  it("timezone は 64 文字まで(IANA の検証は Domain)", () => {
    expect(parse({ enabled: true, localTime: "07:30", timezone: "Asia/Tokyo" }).success).toBe(true);
    expect(parse({ enabled: true, localTime: "07:30", timezone: "A".repeat(65) }).success).toBe(
      false,
    );
  });
});

describe("notificationSettingsResponseSchema", () => {
  it("未保存の既定値(updatedAt: null)を表現できる", () => {
    expect(
      notificationSettingsResponseSchema.safeParse({
        enabled: false,
        localTime: "20:00",
        timezone: "Asia/Tokyo",
        quietHours: { start: "22:00", end: "07:00" },
        updatedAt: null,
      }).success,
    ).toBe(true);
  });
});
