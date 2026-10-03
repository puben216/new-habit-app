import { InvalidDailyCheckInError } from "@habit-app/domain";
import { describe, expect, it } from "vitest";

import { createFakeProfileRepository } from "../identity/test-fakes";
import {
  CHECK_IN_BACKDATE_LIMIT_DAYS,
  getDailyCheckInUseCase,
  upsertDailyCheckInUseCase,
} from "./check-in-use-cases";
import { createFakeDailyCheckInRepository } from "./check-in-test-fakes";
import { CheckInDateOutOfRangeError, DailyCheckInNotFoundError, UserNotFoundError } from "./errors";

const USER_A = "1";
const USER_B = "2";
// 2026-01-14(水)12:00 JST
const WED_NOON_JST = "2026-01-14T03:00:00Z";

function setup(nowIso = WED_NOON_JST, timezone = "Asia/Tokyo") {
  const now = new Date(nowIso);
  const checkInRepository = createFakeDailyCheckInRepository([USER_A, USER_B]);
  const profileRepository = createFakeProfileRepository([USER_A, USER_B]);
  profileRepository.seed({
    userId: USER_A,
    displayName: null,
    timezone,
    locale: "ja",
    weekStartsOn: 1,
    updatedAt: now,
  });
  const deps = { checkInRepository, profileRepository, now: () => now };
  return { checkInRepository, deps };
}

const base = { actorUserId: USER_A, date: "2026-01-14" };

describe("upsertDailyCheckInUseCase", () => {
  it("作成し、訂正は全項目を置換して 1 件のまま。再送は同一内容", async () => {
    const { deps, checkInRepository } = setup();
    const created = await upsertDailyCheckInUseCase(deps, {
      ...base,
      mood: 4,
      difficulty: 2,
      note: "歩いた",
    });
    expect(created).toMatchObject({ date: "2026-01-14", mood: 4, difficulty: 2, note: "歩いた" });

    const replaced = await upsertDailyCheckInUseCase(deps, { ...base, mood: 5 });
    expect(replaced).toMatchObject({ mood: 5, difficulty: null, note: null });
    expect(replaced.createdAt).toEqual(created.createdAt);

    const again = await upsertDailyCheckInUseCase(deps, { ...base, mood: 5 });
    expect(again).toEqual(replaced);
    expect(checkInRepository.records.size).toBe(1);
  });

  it("note を正規化して保存する", async () => {
    const { deps } = setup();
    const saved = await upsertDailyCheckInUseCase(deps, { ...base, mood: 3, note: "  ok  " });
    expect(saved.note).toBe("ok");
  });

  it("内容が不正(全項目未設定、値域外)なら何も保存しない", async () => {
    const { deps, checkInRepository } = setup();
    await expect(upsertDailyCheckInUseCase(deps, { ...base })).rejects.toBeInstanceOf(
      InvalidDailyCheckInError,
    );
    await expect(upsertDailyCheckInUseCase(deps, { ...base, mood: 6 })).rejects.toBeInstanceOf(
      InvalidDailyCheckInError,
    );
    expect(checkInRepository.records.size).toBe(0);
  });

  it("対象日の範囲: 今日と 7 日前は受理、未来日・8 日前・実在しない日は拒否", async () => {
    const { deps } = setup();
    expect(CHECK_IN_BACKDATE_LIMIT_DAYS).toBe(7);
    const input = { actorUserId: USER_A, mood: 3 };
    await expect(
      upsertDailyCheckInUseCase(deps, { ...input, date: "2026-01-14" }),
    ).resolves.toBeDefined();
    await expect(
      upsertDailyCheckInUseCase(deps, { ...input, date: "2026-01-07" }),
    ).resolves.toBeDefined();
    for (const date of ["2026-01-06", "2026-01-15", "2026-02-30"]) {
      await expect(upsertDailyCheckInUseCase(deps, { ...input, date })).rejects.toBeInstanceOf(
        CheckInDateOutOfRangeError,
      );
    }
  });

  it("「今日」は actor の timezone のローカル日で決まる", async () => {
    // 2026-01-13T20:00:00Z は UTC では 1/13、Asia/Tokyo では 1/14
    const { deps } = setup("2026-01-13T20:00:00Z", "Asia/Tokyo");
    await expect(upsertDailyCheckInUseCase(deps, { ...base, mood: 3 })).resolves.toBeDefined();
  });

  it("DST 日: America/New_York の 2026-03-08 23:30 は 3/8", async () => {
    const { deps } = setup("2026-03-09T03:30:00Z", "America/New_York");
    await expect(
      upsertDailyCheckInUseCase(deps, { actorUserId: USER_A, date: "2026-03-08", mood: 3 }),
    ).resolves.toBeDefined();
    await expect(
      upsertDailyCheckInUseCase(deps, { actorUserId: USER_A, date: "2026-03-09", mood: 3 }),
    ).rejects.toBeInstanceOf(CheckInDateOutOfRangeError);
  });

  it("習慣がなくてもチェックインできる(習慣に依存しない)", async () => {
    const { deps } = setup();
    await expect(upsertDailyCheckInUseCase(deps, { ...base, note: "メモ" })).resolves.toBeDefined();
  });

  it("存在しない user は UserNotFound で何も書かない", async () => {
    const { deps, checkInRepository } = setup();
    await expect(
      upsertDailyCheckInUseCase(deps, { actorUserId: "999", date: "2026-01-14", mood: 3 }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
    expect(checkInRepository.records.size).toBe(0);
  });

  it("repository への全呼び出しに actor が渡る", async () => {
    const { deps, checkInRepository } = setup();
    await upsertDailyCheckInUseCase(deps, { ...base, mood: 3 });
    expect(checkInRepository.calls.length).toBeGreaterThan(0);
    for (const call of checkInRepository.calls) expect(call.actorUserId).toBe(USER_A);
  });
});

describe("getDailyCheckInUseCase", () => {
  it("自分のチェックインを返し、なければ NotFound", async () => {
    const { deps, checkInRepository } = setup();
    await upsertDailyCheckInUseCase(deps, { ...base, mood: 4 });
    const found = await getDailyCheckInUseCase(
      { checkInRepository },
      { actorUserId: USER_A, date: "2026-01-14" },
    );
    expect(found.mood).toBe(4);
    await expect(
      getDailyCheckInUseCase({ checkInRepository }, { actorUserId: USER_A, date: "2026-01-13" }),
    ).rejects.toBeInstanceOf(DailyCheckInNotFoundError);
  });

  it("他ユーザーのチェックインは取得できない", async () => {
    const { deps, checkInRepository } = setup();
    await upsertDailyCheckInUseCase(deps, { ...base, mood: 4 });
    await expect(
      getDailyCheckInUseCase({ checkInRepository }, { actorUserId: USER_B, date: "2026-01-14" }),
    ).rejects.toBeInstanceOf(DailyCheckInNotFoundError);
    for (const call of checkInRepository.calls.filter((c) => c.method === "find")) {
      expect([USER_A, USER_B]).toContain(call.actorUserId);
    }
  });
});
