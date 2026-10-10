import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/lib/api/api-error";

import {
  FORM_INVALID_MESSAGE,
  IN_QUIET_HOURS_MESSAGE,
  UNEXPECTED_MESSAGE,
  describeNotificationError,
  statusLabel,
  toPutBody,
  toggleBody,
  validateForm,
  valuesFromSaved,
  type Saved,
} from "./settings";

const saved = (overrides: Partial<Saved> = {}): Saved => ({
  enabled: true,
  localTime: "07:30",
  timezone: "Asia/Tokyo",
  quietHours: { start: "23:00", end: "06:00" },
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...overrides,
});

describe("valuesFromSaved", () => {
  it("quiet hours が null ならチェックなしで、入力欄には既定値を残す", () => {
    const values = valuesFromSaved(saved({ quietHours: null }));
    expect(values.quietEnabled).toBe(false);
    expect([values.quietStart, values.quietEnd]).toEqual(["22:00", "07:00"]);
  });

  it("保存済みの quiet hours を引き継ぐ", () => {
    const values = valuesFromSaved(saved());
    expect(values).toMatchObject({ quietEnabled: true, quietStart: "23:00", quietEnd: "06:00" });
  });
});

describe("validateForm", () => {
  const base = valuesFromSaved(saved());
  it("送信時刻が空は required、quiet hours は設定する場合のみ開始・終了を必須にする", () => {
    expect(validateForm(base)).toEqual({});
    expect(validateForm({ ...base, localTime: "" }).localTime).toBe("required");
    expect(validateForm({ ...base, quietStart: "" }).quietHours).toBe("required");
    expect(validateForm({ ...base, quietEnd: " " }).quietHours).toBe("required");
    expect(validateForm({ ...base, quietEnabled: false, quietStart: "", quietEnd: "" })).toEqual(
      {},
    );
  });
});

describe("toPutBody", () => {
  it("enabled は保存済みの状態を保ち、quiet hours なしは null", () => {
    const values = valuesFromSaved(saved({ enabled: false }));
    expect(toPutBody(saved({ enabled: false }), values).enabled).toBe(false);
    expect(toPutBody(saved({ enabled: true }), values).enabled).toBe(true);
    expect(toPutBody(saved(), { ...values, quietEnabled: false }).quietHours).toBeNull();
    expect(toPutBody(saved(), values).quietHours).toEqual({ start: "23:00", end: "06:00" });
  });

  it("性質: 任意の保存済み状態・入力でも enabled を変えない", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (enabled, quietEnabled) => {
        const base = saved({ enabled });
        const values = { ...valuesFromSaved(base), quietEnabled, localTime: "09:00" };
        expect(toPutBody(base, values).enabled).toBe(enabled);
      }),
    );
  });
});

describe("toggleBody", () => {
  it("保存済みの値だけを使い、enabled だけを指定どおりにする", () => {
    expect(toggleBody(saved({ enabled: true }), false)).toEqual({
      enabled: false,
      localTime: "07:30",
      timezone: "Asia/Tokyo",
      quietHours: { start: "23:00", end: "06:00" },
    });
    expect(toggleBody(saved({ quietHours: null, enabled: false }), true).quietHours).toBeNull();
  });

  it("性質: 保存済みの時刻・timezone・quiet hours を変えない", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (from, to) => {
        const base = saved({ enabled: from });
        const body = toggleBody(base, to);
        expect(body.enabled).toBe(to);
        expect(body.localTime).toBe(base.localTime);
        expect(body.timezone).toBe(base.timezone);
        expect(body.quietHours).toEqual(base.quietHours);
      }),
    );
  });
});

describe("statusLabel", () => {
  it("有効・停止中・未保存を文字で表す", () => {
    expect(statusLabel(saved())).toBe("リマインドメール: 有効");
    expect(statusLabel(saved({ enabled: false }))).toBe("リマインドメール: 停止中");
    expect(statusLabel(saved({ enabled: false, updatedAt: null }))).toBe(
      "リマインドメール: 停止中(まだ設定していません)",
    );
  });
});

describe("describeNotificationError", () => {
  it("quiet hours 内の拒否は送信時刻の固定文言", () => {
    const error = new ApiError({
      status: 422,
      code: "reminder_time_in_quiet_hours",
      fieldErrors: { localTime: ["SECRET"] },
    });
    const described = describeNotificationError(error);
    expect(described.fields.localTime).toBe(IN_QUIET_HOURS_MESSAGE);
    expect(JSON.stringify(described)).not.toContain("SECRET");
  });

  it("fieldErrors のキーから固定文言を選ぶ(quietHours.* も対応)", () => {
    const described = describeNotificationError(
      new ApiError({
        status: 422,
        code: "invalid_notification_setting",
        fieldErrors: { "quietHours.start": ["x"], timezone: ["y"] },
      }),
    );
    expect(Object.keys(described.fields).sort()).toEqual(["quietHours", "timezone"]);
    expect(described.form).toBeNull();
  });

  it("未知のキー・他のエラーはフォーム全体の固定文言", () => {
    expect(
      describeNotificationError(
        new ApiError({ status: 422, code: "validation_failed", fieldErrors: { _root: ["x"] } }),
      ).form,
    ).toBe(FORM_INVALID_MESSAGE);
    expect(describeNotificationError(new ApiError({ status: 500, code: "x" })).form).toBe(
      UNEXPECTED_MESSAGE,
    );
    expect(describeNotificationError(new Error("SECRET")).form).toBe(UNEXPECTED_MESSAGE);
    expect(
      describeNotificationError(new ApiError({ status: 0, code: CLIENT_ERROR_CODES.networkError }))
        .form,
    ).toContain("通信");
  });
});
