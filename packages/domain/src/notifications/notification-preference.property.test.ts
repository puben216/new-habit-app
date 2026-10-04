import { describe, expect, it } from "vitest";

import { ReminderTimeInQuietHoursError } from "./errors";
import { isWithinQuietHours, resolveNotificationPreference } from "./notification-preference";

/**
 * 不変条件のプロパティテスト。ライブラリ(fast-check 等)は未導入のため、固定シードの
 * 疑似乱数で入力を生成する(失敗時に再現できる)。
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const toTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** 実装とは独立した参照実装: 開始から終了まで 1 分ずつ進めて(日跨ぎ込みで)集合を作る。 */
function quietMinutes(start: number, end: number): Set<number> {
  const set = new Set<number>();
  for (let m = start; m !== end; m = (m + 1) % 1440) set.add(m);
  return set;
}

describe("isWithinQuietHours の不変条件", () => {
  it("全ての分(1440 通り)で、ランダムな区間の参照実装と一致する", () => {
    const random = createRandom(401);
    for (let i = 0; i < 40; i += 1) {
      const start = Math.floor(random() * 1440);
      let end = Math.floor(random() * 1440);
      if (end === start) end = (end + 1) % 1440;
      const expected = quietMinutes(start, end);
      const quietHours = { start: toTime(start), end: toTime(end) };
      for (let m = 0; m < 1440; m += 1) {
        expect(isWithinQuietHours(toTime(m), quietHours)).toBe(expected.has(m));
      }
    }
  });

  it("[s,e) と [e,s) は 1 日を過不足なく二分する(どの時刻もちょうど一方に含まれる)", () => {
    const random = createRandom(402);
    for (let i = 0; i < 40; i += 1) {
      const start = Math.floor(random() * 1440);
      const end = (start + 1 + Math.floor(random() * 1439)) % 1440;
      const a = { start: toTime(start), end: toTime(end) };
      const b = { start: toTime(end), end: toTime(start) };
      for (let m = 0; m < 1440; m += 1) {
        expect(isWithinQuietHours(toTime(m), a)).not.toBe(isWithinQuietHours(toTime(m), b));
      }
    }
  });

  it("開始時刻は含み、終了時刻は含まない", () => {
    const random = createRandom(403);
    for (let i = 0; i < 200; i += 1) {
      const start = Math.floor(random() * 1440);
      const end = (start + 1 + Math.floor(random() * 1439)) % 1440;
      const quietHours = { start: toTime(start), end: toTime(end) };
      expect(isWithinQuietHours(quietHours.start, quietHours)).toBe(true);
      expect(isWithinQuietHours(quietHours.end, quietHours)).toBe(false);
    }
  });
});

describe("resolveNotificationPreference の不変条件", () => {
  it("有効な設定が受理されたなら、送信時刻は quiet hours の外にある。無効なら矛盾では拒否されない", () => {
    const random = createRandom(404);
    for (let i = 0; i < 2000; i += 1) {
      const localTime = toTime(Math.floor(random() * 1440));
      const start = Math.floor(random() * 1440);
      const end = (start + 1 + Math.floor(random() * 1439)) % 1440;
      const quietHours = random() < 0.2 ? null : { start: toTime(start), end: toTime(end) };

      const conflict = quietHours !== null && isWithinQuietHours(localTime, quietHours);

      if (conflict) {
        expect(() =>
          resolveNotificationPreference({ enabled: true, localTime, quietHours }, "Asia/Tokyo"),
        ).toThrow(ReminderTimeInQuietHoursError);
      } else {
        const result = resolveNotificationPreference(
          { enabled: true, localTime, quietHours },
          "Asia/Tokyo",
        );
        expect(result.localTime).toBe(localTime);
      }

      // 停止は常に保存できる(入力が形式上有効なら)。
      const stopped = resolveNotificationPreference(
        { enabled: false, localTime, quietHours },
        "Asia/Tokyo",
      );
      expect(stopped.enabled).toBe(false);
    }
  });
});
