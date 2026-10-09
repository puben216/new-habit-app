import { describe, expect, it } from "vitest";

import {
  REMINDER_MAX_LATENESS_MINUTES,
  REMINDER_RETRY_BASE_MS,
  REMINDER_RETRY_MAX_MS,
  calculateRetryDelayMs,
  isReminderDue,
  isReminderExpired,
  isTerminalDeliveryStatus,
  reminderDeduplicationKey,
} from "./reminder-delivery";

describe("isReminderExpired / isReminderDue", () => {
  const slot = new Date("2026-01-15T08:00:00Z");
  const at = (minutes: number) => new Date(slot.getTime() + minutes * 60_000);

  it("許容遅延 60 分: 59 分は有効、60 分は期限切れ、61 分も期限切れ", () => {
    expect(REMINDER_MAX_LATENESS_MINUTES).toBe(60);
    expect(isReminderExpired(slot, at(59))).toBe(false);
    expect(isReminderExpired(slot, at(60))).toBe(true);
    expect(isReminderExpired(slot, at(61))).toBe(true);
  });

  it("枠の時刻ちょうどから due、1 ミリ秒前は due でない", () => {
    expect(isReminderDue(slot, slot)).toBe(true);
    expect(isReminderDue(slot, new Date(slot.getTime() - 1))).toBe(false);
  });
});

describe("calculateRetryDelayMs", () => {
  it("jitter なし(random=0)は 0、上限付近(random→1)は指数的に増えて上限 15 分で止まる", () => {
    expect(calculateRetryDelayMs(1, 0)).toBe(0);
    expect(calculateRetryDelayMs(1, 0.999999)).toBeLessThan(REMINDER_RETRY_BASE_MS);
    expect(calculateRetryDelayMs(2, 0.999999)).toBeLessThan(REMINDER_RETRY_BASE_MS * 2);
    expect(calculateRetryDelayMs(2, 0.999999)).toBeGreaterThanOrEqual(REMINDER_RETRY_BASE_MS);
    expect(calculateRetryDelayMs(40, 0.999999)).toBeLessThan(REMINDER_RETRY_MAX_MS);
    expect(calculateRetryDelayMs(40, 0.999999)).toBeGreaterThan(REMINDER_RETRY_MAX_MS - 1000);
  });

  it("任意の試行回数・乱数で 0 以上、上限以下、同じ乱数なら試行が増えても減らない", () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      for (const random of [0, 0.1, 0.5, 0.9, 0.999999]) {
        const delay = calculateRetryDelayMs(attempt, random);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(REMINDER_RETRY_MAX_MS);
        expect(calculateRetryDelayMs(attempt + 1, random)).toBeGreaterThanOrEqual(delay);
      }
    }
  });

  it("範囲外の乱数は丸める", () => {
    expect(calculateRetryDelayMs(3, -1)).toBe(0);
    expect(calculateRetryDelayMs(3, 5)).toBeLessThan(REMINDER_RETRY_MAX_MS);
  });
});

describe("状態と dedupe キー", () => {
  it("pending 以外は終端", () => {
    expect(isTerminalDeliveryStatus("pending")).toBe(false);
    for (const status of ["sent", "skipped", "expired", "suppressed", "failed"] as const) {
      expect(isTerminalDeliveryStatus(status)).toBe(true);
    }
  });

  it("dedupe キーは設定とローカル日で決まる", () => {
    expect(reminderDeduplicationKey("12", "2026-01-15")).toBe("reminder:12:2026-01-15");
    expect(reminderDeduplicationKey("12", "2026-01-16")).not.toBe(
      reminderDeduplicationKey("12", "2026-01-15"),
    );
  });
});
