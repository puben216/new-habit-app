import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_REMINDER_LOCAL_TIME,
  createDefaultProfile,
  resolveNotificationPreference,
} from "@habit-app/domain";
import type { QuietHours } from "@habit-app/domain";

import type { Clock } from "../auth";
import type { ProfileRepositoryPort } from "../identity/ports";
import { NotificationUserNotFoundError } from "./errors";
import type { NotificationSettingsRecord, NotificationSettingsRepositoryPort } from "./ports";

/**
 * 通知設定の use case(docs/specs/notification-preferences.md)。
 * 内容の検証は Domain の `resolveNotificationPreference` だけが行い、ここでは再実装しない。
 */

/** 未保存のユーザーに返す既定値は `updatedAt: null`(DB に行がないことを表す)。 */
export interface NotificationSettingsView extends Omit<NotificationSettingsRecord, "updatedAt"> {
  readonly updatedAt: Date | null;
}

export interface GetNotificationSettingsDeps {
  readonly settingsRepository: NotificationSettingsRepositoryPort;
  readonly profileRepository: ProfileRepositoryPort;
}

export interface GetNotificationSettingsInput {
  readonly actorUserId: string;
}

/**
 * 自分の通知設定を返す(NPF-001)。未保存なら無効の既定値を返し、設定の行は作らない。
 *
 * @throws {NotificationUserNotFoundError} actor の user が存在しない
 */
export async function getNotificationSettingsUseCase(
  deps: GetNotificationSettingsDeps,
  input: GetNotificationSettingsInput,
): Promise<NotificationSettingsView> {
  const saved = await deps.settingsRepository.find({ actorUserId: input.actorUserId });
  if (saved !== null) return saved;

  const profile = await deps.profileRepository.ensure(input.actorUserId, createDefaultProfile());
  if (profile === null) throw new NotificationUserNotFoundError();
  return {
    enabled: false,
    localTime: DEFAULT_REMINDER_LOCAL_TIME,
    timezone: profile.timezone,
    quietHours: DEFAULT_QUIET_HOURS,
    updatedAt: null,
  };
}

export interface UpsertNotificationSettingsDeps {
  readonly settingsRepository: NotificationSettingsRepositoryPort;
  readonly profileRepository: ProfileRepositoryPort;
  readonly now: Clock;
}

export interface UpsertNotificationSettingsInput {
  readonly actorUserId: string;
  readonly enabled: boolean;
  readonly localTime: string;
  /** `undefined` は既定値、`null` は quiet hours なし。 */
  readonly quietHours?: QuietHours | null | undefined;
  /** `undefined` はプロフィールの timezone。 */
  readonly timezone?: string | undefined;
}

/**
 * 通知設定を冪等に作成・置換する(NPF-002〜004。`enabled: false` が配信停止)。
 *
 * @throws {NotificationUserNotFoundError} actor の user が存在しない
 * @throws {InvalidNotificationPreferenceError} 時刻・timezone・quiet hours が不正
 * @throws {ReminderTimeInQuietHoursError} 有効で送信時刻が quiet hours 内
 */
export async function upsertNotificationSettingsUseCase(
  deps: UpsertNotificationSettingsDeps,
  input: UpsertNotificationSettingsInput,
): Promise<NotificationSettingsRecord> {
  const profile = await deps.profileRepository.ensure(input.actorUserId, createDefaultProfile());
  if (profile === null) throw new NotificationUserNotFoundError();

  const resolved = resolveNotificationPreference(
    {
      enabled: input.enabled,
      localTime: input.localTime,
      quietHours: input.quietHours,
      timezone: input.timezone,
    },
    profile.timezone,
  );

  const saved = await deps.settingsRepository.upsert({
    actorUserId: input.actorUserId,
    enabled: resolved.enabled,
    localTime: resolved.localTime,
    timezone: resolved.timezone,
    quietHours: resolved.quietHours,
    now: deps.now(),
  });
  if (saved === null) throw new NotificationUserNotFoundError();
  return saved;
}
