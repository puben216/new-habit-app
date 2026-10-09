import { describe, expect, it } from "vitest";

import { createFakeDeliveryRepository, createFakeQueue } from "./delivery-test-fakes";
import { scheduleDueRemindersUseCase } from "./schedule-due-reminders";

const TOKYO_0800 = {
  settingId: "10",
  userId: "1",
  localTime: "08:00",
  timezone: "Asia/Tokyo",
};

function setup(nowIso: string, settings = [TOKYO_0800]) {
  const deliveryRepository = createFakeDeliveryRepository();
  deliveryRepository.setSettings(settings);
  const queue = createFakeQueue();
  const now = new Date(nowIso);
  const run = (at: Date = now) =>
    scheduleDueRemindersUseCase({ deliveryRepository, queue, now: () => at });
  return { deliveryRepository, queue, run, now };
}

describe("scheduleDueRemindersUseCase", () => {
  it("送信枠に達した設定の配送を 1 件だけ作り、deliveryId のみを投入する。2 回実行しても重複しない", async () => {
    // 東京 2026-01-15 08:02(枠は 08:00)
    const { deliveryRepository, queue, run } = setup("2026-01-14T23:02:00Z");
    const first = await run();
    const second = await run();

    expect(first).toMatchObject({ scanned: 1, created: 1, enqueued: 1, enqueueFailed: 0 });
    expect(second).toMatchObject({ created: 0, enqueued: 0 });
    expect(deliveryRepository.rows.size).toBe(1);
    const row = [...deliveryRepository.rows.values()][0];
    expect(row).toMatchObject({
      localDate: "2026-01-15",
      status: "pending",
      deduplicationKey: "reminder:10:2026-01-15",
    });
    expect(row?.scheduledAt.toISOString()).toBe("2026-01-14T23:00:00.000Z");
    // message は配送 ID のみ(email・user ID・設定を含まない)。
    expect(queue.batches).toEqual([[row?.id]]);
  });

  it("枠の前(07:59)と許容遅延の後(09:00 以降)は作らない。08:59 はまだ有効", async () => {
    expect((await setup("2026-01-14T22:59:00Z").run()).created).toBe(0); // 07:59
    expect((await setup("2026-01-14T23:59:00Z").run()).created).toBe(1); // 08:59
    expect((await setup("2026-01-15T00:00:00Z").run()).created).toBe(0); // 09:00
    expect((await setup("2026-01-15T00:01:00Z").run()).created).toBe(0); // 09:01
  });

  it("日付境界をまたぐ枠: 23:50 の枠を翌日 00:10 に拾う", async () => {
    const { deliveryRepository, run } = setup("2026-01-15T15:10:00Z", [
      { ...TOKYO_0800, localTime: "23:50" },
    ]); // 東京 2026-01-16 00:10
    await run();
    const row = [...deliveryRepository.rows.values()][0];
    expect(row?.localDate).toBe("2026-01-15");
    expect(row?.scheduledAt.toISOString()).toBe("2026-01-15T14:50:00.000Z");
  });

  it("DST の gap: New_York 02:30 の枠は 03:00 EDT(07:00Z)", async () => {
    const { deliveryRepository, run } = setup("2026-03-08T07:05:00Z", [
      { settingId: "11", userId: "2", localTime: "02:30", timezone: "America/New_York" },
    ]);
    await run();
    const row = [...deliveryRepository.rows.values()][0];
    expect(row?.scheduledAt.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("DST の fall-back: 01:30 の枠は 1 回だけ(早い方 05:30Z)で、重複側の 06:30Z には作らない", async () => {
    const settings = [
      { settingId: "12", userId: "3", localTime: "01:30", timezone: "America/New_York" },
    ];
    const first = setup("2026-11-01T05:40:00Z", settings);
    await first.run();
    expect(first.deliveryRepository.rows.size).toBe(1);
    // 同じローカル時刻がもう一度現れる 06:40Z は、枠(05:30Z)から 70 分後で許容遅延を過ぎている。
    const second = setup("2026-11-01T06:40:00Z", settings);
    await second.run();
    expect(second.deliveryRepository.rows.size).toBe(0);
  });

  it("設定が複数ページにまたがっても全件を走査する", async () => {
    const many = Array.from({ length: 1203 }, (_, i) => ({
      settingId: String(i + 1),
      userId: String(i + 1),
      localTime: "08:00",
      timezone: "Asia/Tokyo",
    }));
    const { deliveryRepository, run } = setup("2026-01-14T23:02:00Z", many);
    const summary = await run();
    expect(summary.scanned).toBe(1203);
    expect(deliveryRepository.rows.size).toBe(1203);
  });

  it("計算できない設定(timezone 破損)は数えて続行し、他の設定は処理する", async () => {
    const { deliveryRepository, run } = setup("2026-01-14T23:02:00Z", [
      { settingId: "1", userId: "1", localTime: "08:00", timezone: "Not/AZone" },
      TOKYO_0800,
    ]);
    const summary = await run();
    expect(summary).toMatchObject({ scanned: 2, invalidSettings: 1, created: 1 });
    expect(deliveryRepository.rows.size).toBe(1);
  });

  it("DB 障害などの予期しない例外は『不正な設定』として握りつぶさず、呼び出し側へ伝える", async () => {
    const { deliveryRepository, run } = setup("2026-01-14T23:02:00Z");
    deliveryRepository.createPendingIfAbsent = async () => {
      throw new Error("connection refused");
    };
    await expect(run()).rejects.toThrow("connection refused");
  });

  it("投入に失敗した配送は次の実行で再投入される。直後の実行では二重投入しない", async () => {
    const { deliveryRepository, queue, run, now } = setup("2026-01-14T23:02:00Z");
    queue.failAll = true;
    const failed = await run();
    expect(failed).toMatchObject({ created: 1, enqueued: 0, enqueueFailed: 1 });
    expect([...deliveryRepository.rows.values()][0]?.enqueuedAt).toBeNull();

    queue.failAll = false;
    const retried = await run(new Date(now.getTime() + 60_000));
    expect(retried).toMatchObject({ created: 0, enqueued: 1 });

    const again = await run(new Date(now.getTime() + 2 * 60_000));
    expect(again.enqueued).toBe(0);
  });

  it("投入済みで 10 分以上たった pending は再投入するが、10 分未満はしない", async () => {
    const { deliveryRepository, queue, run, now } = setup("2026-01-14T23:02:00Z");
    await run();
    expect(queue.batches).toHaveLength(1);
    expect((await run(new Date(now.getTime() + 9 * 60_000))).enqueued).toBe(0);
    expect((await run(new Date(now.getTime() + 11 * 60_000))).enqueued).toBe(1);
    expect(deliveryRepository.rows.size).toBe(1);
  });

  it("再試行待ち(next_attempt_at が未来)の配送は投入しない", async () => {
    const { deliveryRepository, queue, run, now } = setup("2026-01-14T23:02:00Z", []);
    deliveryRepository.seedPending({
      id: "50",
      setting: TOKYO_0800,
      scheduledAt: new Date("2026-01-14T23:00:00Z"),
      nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
    });
    expect((await run()).enqueued).toBe(0);
    expect(queue.batches).toHaveLength(0);
  });

  it("試行が上限に達した pending は failed(retries_exhausted)にする", async () => {
    const { deliveryRepository, run } = setup("2026-01-14T23:02:00Z", []);
    deliveryRepository.seedPending({
      id: "51",
      setting: TOKYO_0800,
      scheduledAt: new Date("2026-01-14T23:00:00Z"),
      attemptCount: 5,
      lockedUntil: new Date("2026-01-14T23:00:30Z"),
    });
    expect((await run()).exhausted).toBe(1);
    expect(deliveryRepository.rows.get("51")).toMatchObject({
      status: "failed",
      failureCode: "retries_exhausted",
    });
  });
});
