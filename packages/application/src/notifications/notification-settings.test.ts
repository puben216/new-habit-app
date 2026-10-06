import {
  InvalidNotificationPreferenceError,
  ReminderTimeInQuietHoursError,
} from "@habit-app/domain";
import { describe, expect, it } from "vitest";

import { createFakeProfileRepository } from "../identity/test-fakes";
import { NotificationUserNotFoundError } from "./errors";
import { createFakeNotificationSettingsRepository } from "./test-fakes";
import { getNotificationSettingsUseCase, upsertNotificationSettingsUseCase } from "./use-cases";

const USER_A = "1";
const USER_B = "2";
const NOW = new Date("2026-10-04T03:00:00.000Z");

function setup(timezone = "Asia/Tokyo") {
  const settingsRepository = createFakeNotificationSettingsRepository([USER_A, USER_B]);
  const profileRepository = createFakeProfileRepository([USER_A, USER_B]);
  profileRepository.seed({
    userId: USER_A,
    displayName: null,
    timezone,
    locale: "ja",
    weekStartsOn: 1,
    updatedAt: NOW,
  });
  const deps = { settingsRepository, profileRepository, now: () => NOW };
  return { settingsRepository, deps };
}

describe("getNotificationSettingsUseCase", () => {
  it("未保存なら無効の既定値(プロフィールの timezone)を返し、何も保存しない", async () => {
    const { deps, settingsRepository } = setup("America/New_York");
    const view = await getNotificationSettingsUseCase(deps, { actorUserId: USER_A });
    expect(view).toEqual({
      enabled: false,
      localTime: "20:00",
      timezone: "America/New_York",
      quietHours: { start: "22:00", end: "07:00" },
      updatedAt: null,
    });
    expect(settingsRepository.records.size).toBe(0);
  });

  it("保存済みの設定を返す", async () => {
    const { deps } = setup();
    await upsertNotificationSettingsUseCase(deps, {
      actorUserId: USER_A,
      enabled: true,
      localTime: "07:30",
    });
    const view = await getNotificationSettingsUseCase(deps, { actorUserId: USER_A });
    expect(view).toMatchObject({ enabled: true, localTime: "07:30", updatedAt: NOW });
  });

  it("他ユーザーの設定は返さない", async () => {
    const { deps, settingsRepository } = setup();
    await upsertNotificationSettingsUseCase(deps, {
      actorUserId: USER_A,
      enabled: true,
      localTime: "07:30",
    });
    const view = await getNotificationSettingsUseCase(deps, { actorUserId: USER_B });
    expect(view.enabled).toBe(false);
    expect(view.updatedAt).toBeNull();
    expect(settingsRepository.calls.at(-1)).toEqual({ method: "find", actorUserId: USER_B });
  });

  it("user が存在しなければ NotificationUserNotFoundError", async () => {
    const { deps } = setup();
    await expect(getNotificationSettingsUseCase(deps, { actorUserId: "999" })).rejects.toThrow(
      NotificationUserNotFoundError,
    );
  });
});

describe("upsertNotificationSettingsUseCase", () => {
  const base = { actorUserId: USER_A, enabled: true, localTime: "07:30" };

  it("省略した quietHours と timezone に既定値を適用して保存する", async () => {
    const { deps } = setup();
    const saved = await upsertNotificationSettingsUseCase(deps, base);
    expect(saved).toEqual({
      enabled: true,
      localTime: "07:30",
      timezone: "Asia/Tokyo",
      quietHours: { start: "22:00", end: "07:00" },
      updatedAt: NOW,
    });
  });

  it("全項目を置換し、再送は同一内容。quietHours: null は quiet hours なし", async () => {
    const { deps, settingsRepository } = setup();
    await upsertNotificationSettingsUseCase(deps, base);
    const replaced = await upsertNotificationSettingsUseCase(deps, {
      ...base,
      localTime: "21:00",
      quietHours: null,
    });
    const again = await upsertNotificationSettingsUseCase(deps, {
      ...base,
      localTime: "21:00",
      quietHours: null,
    });
    expect(replaced.quietHours).toBeNull();
    expect(again).toEqual(replaced);
    expect(settingsRepository.records.size).toBe(1);
  });

  it("配信停止: enabled=false で保存され localTime は保持される", async () => {
    const { deps } = setup();
    await upsertNotificationSettingsUseCase(deps, base);
    const stopped = await upsertNotificationSettingsUseCase(deps, { ...base, enabled: false });
    expect(stopped).toMatchObject({ enabled: false, localTime: "07:30" });
  });

  it("無効なら送信時刻が quiet hours 内でも保存できるが、有効なら拒否する", async () => {
    const { deps, settingsRepository } = setup();
    await expect(
      upsertNotificationSettingsUseCase(deps, { ...base, localTime: "23:00" }),
    ).rejects.toThrow(ReminderTimeInQuietHoursError);
    expect(settingsRepository.records.size).toBe(0);
    const saved = await upsertNotificationSettingsUseCase(deps, {
      ...base,
      localTime: "23:00",
      enabled: false,
    });
    expect(saved.enabled).toBe(false);
  });

  it("不正な timezone は拒否し、何も保存しない", async () => {
    const { deps, settingsRepository } = setup();
    await expect(
      upsertNotificationSettingsUseCase(deps, { ...base, timezone: "JST" }),
    ).rejects.toThrow(InvalidNotificationPreferenceError);
    expect(settingsRepository.records.size).toBe(0);
  });

  it("timezone を明示するとプロフィールより優先される", async () => {
    const { deps } = setup();
    const saved = await upsertNotificationSettingsUseCase(deps, {
      ...base,
      timezone: "Europe/London",
    });
    expect(saved.timezone).toBe("Europe/London");
  });

  it("user が存在しなければ NotificationUserNotFoundError。actor が repository に渡る", async () => {
    const { deps, settingsRepository } = setup();
    await expect(
      upsertNotificationSettingsUseCase(deps, { ...base, actorUserId: "999" }),
    ).rejects.toThrow(NotificationUserNotFoundError);

    await upsertNotificationSettingsUseCase(deps, base);
    expect(settingsRepository.calls).toEqual([{ method: "upsert", actorUserId: USER_A }]);
  });

  it("プロフィール取得後に user が消えた場合(repository が null)も NotificationUserNotFoundError", async () => {
    const { deps } = setup();
    // プロフィールは存在するが、settings 側の repository は user を知らない状態を再現する。
    deps.profileRepository.seed({
      userId: "3",
      displayName: null,
      timezone: "Asia/Tokyo",
      locale: "ja",
      weekStartsOn: 1,
      updatedAt: NOW,
    });
    await expect(
      upsertNotificationSettingsUseCase(deps, { ...base, actorUserId: "3" }),
    ).rejects.toThrow(NotificationUserNotFoundError);
  });
});
