import { describe, expect, it, vi } from "vitest";

import { ReminderEmailError } from "./delivery-ports";
import type { ReminderRecipient } from "./delivery-ports";
import { deliverReminderUseCase } from "./deliver-reminder";
import {
  createFakeDeliveryRepository,
  createFakeEmailSender,
  createFakeSuppressions,
  createFakeUnsubscribeTokens,
} from "./delivery-test-fakes";
import { createFakeNotificationSettingsRepository } from "./test-fakes";

const USER = "1";
const SETTING = { settingId: "10", userId: USER, localTime: "08:00", timezone: "Asia/Tokyo" };
const SCHEDULED_AT = new Date("2026-01-14T23:00:00Z"); // 東京 2026-01-15 08:00
const AT_0805 = new Date("2026-01-14T23:05:00Z");

function setup(
  options: { now?: Date; recipient?: ReminderRecipient | null; withSetting?: boolean } = {},
) {
  let current = options.now ?? AT_0805;
  const deliveryRepository = createFakeDeliveryRepository();
  deliveryRepository.seedPending({ id: "100", setting: SETTING, scheduledAt: SCHEDULED_AT });
  const settingsRepository = createFakeNotificationSettingsRepository([USER], {
    "pub-1": USER,
  });
  if (options.withSetting !== false) {
    settingsRepository.seed(USER, {
      enabled: true,
      localTime: "08:00",
      timezone: "Asia/Tokyo",
      quietHours: { start: "22:00", end: "07:00" },
      updatedAt: SCHEDULED_AT,
    });
  }
  const suppressions = createFakeSuppressions();
  const emailSender = createFakeEmailSender();
  const hasUnrecordedSchedule = vi.fn(async () => true);
  const recipient =
    options.recipient === undefined
      ? { email: "member@example.test", userPublicId: "pub-1" }
      : options.recipient;
  const deps = {
    deliveryRepository,
    settingsRepository,
    suppressions,
    recipients: { findRecipient: vi.fn(async () => recipient) },
    emailSender,
    unsubscribeTokens: createFakeUnsubscribeTokens(),
    hasUnrecordedSchedule,
    random: () => 0.5,
    now: () => current,
    appBaseUrl: "https://app.example.test",
  };
  const run = () => deliverReminderUseCase(deps, { deliveryId: "100" });
  return {
    deps,
    run,
    deliveryRepository,
    settingsRepository,
    suppressions,
    emailSender,
    hasUnrecordedSchedule,
    setNow: (next: Date) => {
      current = next;
    },
  };
}

const row = (s: ReturnType<typeof setup>) => s.deliveryRepository.rows.get("100");

describe("deliverReminderUseCase", () => {
  it("送信成功: sent と provider_message_id を記録し、本文に配信停止リンクを含む。email は記録しない", async () => {
    const s = setup();
    expect(await s.run()).toBe("sent");
    expect(s.emailSender.sent).toHaveLength(1);
    const mail = s.emailSender.sent[0];
    expect(mail?.to).toBe("member@example.test");
    expect(mail?.unsubscribeUrl).toBe(
      "https://app.example.test/api/v1/notification-unsubscribe?token=fake.pub-1",
    );
    expect(mail?.text).toContain(mail?.unsubscribeUrl);
    expect(row(s)).toMatchObject({ status: "sent", providerMessageId: "msg-1", failureCode: null });
    expect(JSON.stringify(row(s))).not.toContain("member@example.test");
  });

  it("同じ message をもう一度処理しても送信されない(重複 message は noop)", async () => {
    const s = setup();
    await s.run();
    expect(await s.run()).toBe("noop");
    expect(s.emailSender.sent).toHaveLength(1);
  });

  it("並行に 6 件処理しても送信は 1 回(claim が排他)", async () => {
    const s = setup();
    const outcomes = await Promise.all([1, 2, 3, 4, 5, 6].map(() => s.run()));
    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "noop")).toHaveLength(5);
    expect(s.emailSender.sent).toHaveLength(1);
  });

  it("許容遅延: 59 分は送る、60 分以降は expired", async () => {
    const late = setup({ now: new Date(SCHEDULED_AT.getTime() + 59 * 60_000) });
    expect(await late.run()).toBe("sent");
    const expired = setup({ now: new Date(SCHEDULED_AT.getTime() + 60 * 60_000) });
    expect(await expired.run()).toBe("expired");
    expect(expired.emailSender.sent).toHaveLength(0);
  });

  it("遅延で現在が quiet hours に入っていたら expired(60 分以内でも)", async () => {
    const s = setup({ now: new Date("2026-01-14T23:30:00Z") });
    s.settingsRepository.seed(USER, {
      enabled: true,
      localTime: "08:00",
      timezone: "Asia/Tokyo",
      // 東京 08:30 を含む quiet hours に変更された
      quietHours: { start: "08:15", end: "09:00" },
      updatedAt: SCHEDULED_AT,
    });
    expect(await s.run()).toBe("expired");
    expect(s.emailSender.sent).toHaveLength(0);
  });

  it("設定が無効、または設定が存在しない場合は skipped(disabled)", async () => {
    const disabled = setup();
    disabled.settingsRepository.seed(USER, {
      enabled: false,
      localTime: "08:00",
      timezone: "Asia/Tokyo",
      quietHours: null,
      updatedAt: SCHEDULED_AT,
    });
    expect(await disabled.run()).toBe("skipped");
    expect(row(disabled)?.failureCode).toBe("disabled");

    const none = setup({ withSetting: false });
    expect(await none.run()).toBe("skipped");
    expect(none.emailSender.sent).toHaveLength(0);
  });

  it("suppression 済みなら有効な設定でも suppressed", async () => {
    const s = setup();
    await s.suppressions.suppress({ userId: USER, reason: "bounce", now: AT_0805 });
    expect(await s.run()).toBe("suppressed");
    expect(s.emailSender.sent).toHaveLength(0);
  });

  it("当日の予定がすべて記録済み(または予定なし)なら skipped(already_recorded)", async () => {
    const s = setup();
    s.hasUnrecordedSchedule.mockResolvedValueOnce(false);
    expect(await s.run()).toBe("skipped");
    expect(row(s)?.failureCode).toBe("already_recorded");
    expect(s.hasUnrecordedSchedule).toHaveBeenCalledWith({ actorUserId: USER, date: "2026-01-15" });
  });

  it("宛先が取得できなければ failed(no_recipient)", async () => {
    const s = setup({ recipient: null });
    expect(await s.run()).toBe("failed");
    expect(row(s)?.failureCode).toBe("no_recipient");
  });

  it("判定の順序: expired は最優先(設定・suppression を見ない)、disabled は suppression より先", async () => {
    const expired = setup({ now: new Date(SCHEDULED_AT.getTime() + 61 * 60_000) });
    await expired.suppressions.suppress({ userId: USER, reason: "bounce", now: AT_0805 });
    expect(await expired.run()).toBe("expired");

    const both = setup();
    both.settingsRepository.seed(USER, {
      enabled: false,
      localTime: "08:00",
      timezone: "Asia/Tokyo",
      quietHours: null,
      updatedAt: SCHEDULED_AT,
    });
    await both.suppressions.suppress({ userId: USER, reason: "bounce", now: AT_0805 });
    expect(await both.run()).toBe("skipped");
  });

  it("一時的な失敗は pending のまま backoff で再試行時刻を設定し、lease を解除する", async () => {
    const s = setup();
    s.emailSender.script = [new ReminderEmailError("transient", "throttled")];
    expect(await s.run()).toBe("retry");
    const r = row(s);
    expect(r).toMatchObject({
      status: "pending",
      attemptCount: 1,
      failureCode: "throttled",
      lockedUntil: null,
      enqueuedAt: null,
    });
    // random=0.5, attempt=1 → 60 秒 × 0.5 = 30 秒後
    expect(r?.nextAttemptAt.getTime()).toBe(AT_0805.getTime() + 30_000);
  });

  it("再試行の時刻になるまで処理されず、時刻後に成功すれば sent", async () => {
    const s = setup();
    s.emailSender.script = [new ReminderEmailError("transient", "timeout")];
    await s.run();
    expect(await s.run()).toBe("noop"); // まだ時刻でない
    s.setNow(new Date(AT_0805.getTime() + 31_000));
    expect(await s.run()).toBe("sent");
    expect(row(s)?.attemptCount).toBe(2);
  });

  it("一時的な失敗が 5 回続くと failed(retries_exhausted)", async () => {
    const s = setup();
    s.emailSender.script = Array.from(
      { length: 5 },
      () => new ReminderEmailError("transient", "5xx"),
    );
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(await s.run());
      // 次の試行は、記録された再試行時刻(許容遅延の内側)に進める。
      const next = row(s)?.nextAttemptAt;
      if (next !== undefined) s.setNow(next);
    }
    expect(outcomes.slice(0, 4)).toEqual(["retry", "retry", "retry", "retry"]);
    expect(outcomes[4]).toBe("failed");
    expect(row(s)).toMatchObject({
      status: "failed",
      failureCode: "retries_exhausted",
      attemptCount: 5,
    });
    expect(s.emailSender.sent).toHaveLength(0);
  });

  it("永続的な失敗は再試行せず 1 回で failed(分類コードを記録)", async () => {
    const s = setup();
    s.emailSender.script = [new ReminderEmailError("permanent", "rejected")];
    expect(await s.run()).toBe("failed");
    expect(row(s)).toMatchObject({ status: "failed", failureCode: "rejected", attemptCount: 1 });
  });

  it("予期しない例外は握りつぶさず投げる(Lambda が message を残し DLQ へ送る)", async () => {
    const s = setup();
    s.emailSender.script = [new Error("socket hang up")];
    await expect(s.run()).rejects.toThrow("socket hang up");
    expect(row(s)?.status).toBe("pending");
  });

  it("claim 後に別の処理が終端にした行は更新されず noop", async () => {
    const s = setup();
    const original = s.deps.deliveryRepository.finalize.bind(s.deps.deliveryRepository);
    s.deps.deliveryRepository.finalize = async (input) => {
      await original({ ...input, status: "skipped", failureCode: "disabled" }); // 先に終端化される
      return original(input);
    };
    expect(await s.run()).toBe("noop");
    expect(row(s)?.status).toBe("skipped");
  });
});
