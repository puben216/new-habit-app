import type {
  NotificationSettingsResponse,
  UpsertNotificationSettingsRequest,
} from "@habit-app/contracts";

import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";

/**
 * 通知設定の値・body・エラー分類(docs/specs/notification-screen.md)。
 * 時刻の整合(quiet hours 内の拒否、開始=終了の拒否)と timezone の妥当性は server が判定する。
 */
export type Saved = NotificationSettingsResponse;

/** 既定の quiet hours(T-401 の暫定既定値。入力欄の初期表示にだけ使う)。 */
export const FALLBACK_QUIET_HOURS = { start: "22:00", end: "07:00" } as const;

export interface FormValues {
  readonly localTime: string;
  readonly timezone: string;
  readonly quietEnabled: boolean;
  readonly quietStart: string;
  readonly quietEnd: string;
}

export type FormField = "localTime" | "timezone" | "quietHours";

export function valuesFromSaved(saved: Saved): FormValues {
  return {
    localTime: saved.localTime,
    timezone: saved.timezone,
    quietEnabled: saved.quietHours !== null,
    quietStart: saved.quietHours?.start ?? FALLBACK_QUIET_HOURS.start,
    quietEnd: saved.quietHours?.end ?? FALLBACK_QUIET_HOURS.end,
  };
}

/** UX の検証(必須のみ)。整合の判定は server。 */
export function validateForm(values: FormValues): Partial<Record<FormField, "required">> {
  const issues: Partial<Record<FormField, "required">> = {};
  if (values.localTime.trim() === "") issues.localTime = "required";
  if (values.quietEnabled && (values.quietStart.trim() === "" || values.quietEnd.trim() === "")) {
    issues.quietHours = "required";
  }
  return issues;
}

/** 設定の保存。`enabled` は保存済みの状態を保つ(保存だけで有効にしない。NUI-INV-002)。 */
export function toPutBody(saved: Saved, values: FormValues): UpsertNotificationSettingsRequest {
  return {
    enabled: saved.enabled,
    localTime: values.localTime,
    timezone: values.timezone,
    quietHours: values.quietEnabled ? { start: values.quietStart, end: values.quietEnd } : null,
  };
}

/** 停止/再開。画面に編集中の値ではなく、保存済みの値だけを使う(NUI-INV-003)。 */
export function toggleBody(saved: Saved, enabled: boolean): UpsertNotificationSettingsRequest {
  return {
    enabled,
    localTime: saved.localTime,
    timezone: saved.timezone,
    quietHours: saved.quietHours === null ? null : { ...saved.quietHours },
  };
}

export function statusLabel(saved: Saved): string {
  if (saved.enabled) return "リマインドメール: 有効";
  return saved.updatedAt === null
    ? "リマインドメール: 停止中(まだ設定していません)"
    : "リマインドメール: 停止中";
}

export const SAVED_MESSAGE = "保存しました。";
export const STOPPED_MESSAGE = "停止しました。設定は保持されています。";
export const ENABLED_MESSAGE = "有効にしました。";
export const NETWORK_MESSAGE = "通信に失敗しました。時間をおいてもう一度お試しください。";
export const UNEXPECTED_MESSAGE =
  "処理を完了できませんでした。時間をおいてもう一度お試しください。";
export const FORM_INVALID_MESSAGE = "入力内容を確認してください。";
export const IN_QUIET_HOURS_MESSAGE = "送信時刻が送らない時間帯に入っています。";
export const RESUME_REJECTED_MESSAGE =
  "送信時刻が送らない時間帯に入っているため有効にできません。下の設定を見直して保存してください。";

export function issueMessage(field: FormField): string {
  return field === "localTime"
    ? "送信時刻を入力してください。"
    : "送らない時間帯の開始と終了を入力してください。";
}

const SERVER_MESSAGES: Record<FormField, string> = {
  localTime: "送信時刻を確認してください。",
  timezone: "タイムゾーンを選び直してください。",
  quietHours: "送らない時間帯を確認してください(開始と終了を同じ時刻にはできません)。",
};

export interface DescribedError {
  readonly fields: Partial<Record<FormField, string>>;
  readonly form: string | null;
}

/** API 失敗を固定文言へ。使うのは status・code・fieldErrors のキーだけ。 */
export function describeNotificationError(error: unknown): DescribedError {
  if (!isApiError(error)) return { fields: {}, form: UNEXPECTED_MESSAGE };
  if (error.code === CLIENT_ERROR_CODES.networkError) return { fields: {}, form: NETWORK_MESSAGE };
  if (error.status !== 422) return { fields: {}, form: UNEXPECTED_MESSAGE };

  if (error.code === "reminder_time_in_quiet_hours") {
    return { fields: { localTime: IN_QUIET_HOURS_MESSAGE }, form: null };
  }
  const fields: Partial<Record<FormField, string>> = {};
  for (const key of Object.keys(error.fieldErrors ?? {})) {
    const field: FormField | null =
      key === "localTime" || key === "timezone"
        ? key
        : key === "quietHours" || key.startsWith("quietHours.")
          ? "quietHours"
          : null;
    if (field !== null) fields[field] = SERVER_MESSAGES[field];
  }
  return { fields, form: Object.keys(fields).length > 0 ? null : FORM_INVALID_MESSAGE };
}
