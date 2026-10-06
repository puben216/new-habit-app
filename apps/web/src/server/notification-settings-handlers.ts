import { NotificationUserNotFoundError } from "@habit-app/application";
import type {
  NotificationSettingsView,
  UpsertNotificationSettingsInput,
} from "@habit-app/application";
import { upsertNotificationSettingsRequestSchema } from "@habit-app/contracts";
import type { NotificationSettingsResponse } from "@habit-app/contracts";
import {
  InvalidNotificationPreferenceError,
  ReminderTimeInQuietHoursError,
} from "@habit-app/domain";

import {
  invalidOriginResponse,
  isTrustedOrigin,
  jsonResponse,
  problemResponse,
  readJsonBody,
  unauthorizedResponse,
} from "./habit-http";

/**
 * `/api/v1/notification-settings` の route handler 本体(docs/specs/notification-preferences.md)。
 * route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 */

export interface NotificationSettingsUseCases {
  get(input: { readonly actorUserId: string }): Promise<NotificationSettingsView>;
  upsert(input: UpsertNotificationSettingsInput): Promise<NotificationSettingsView>;
}

export interface NotificationSettingsHandlerDeps {
  /** session から actor の user ID を取得する。未認証は null。 */
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  /** 状態変更メソッドで許可する Origin(例: `https://app.example.com`)。 */
  readonly allowedOrigin: string;
  readonly useCases: NotificationSettingsUseCases;
}

export interface NotificationSettingsHandlers {
  get(request: Request): Promise<Response>;
  upsert(request: Request): Promise<Response>;
}

/** use case が投げたエラーを HTTP 応答へ変換する。未知のエラーは null を返し、呼び出し側が再 throw する。 */
function mapNotificationError(error: unknown): Response | null {
  if (error instanceof NotificationUserNotFoundError) {
    return problemResponse(404, { code: "user_not_found", message: "ユーザーが見つかりません" });
  }
  if (error instanceof ReminderTimeInQuietHoursError) {
    return problemResponse(422, {
      code: "reminder_time_in_quiet_hours",
      message: "送信時刻が通知しない時間帯に含まれています",
      fieldErrors: { localTime: ["通知しない時間帯に含まれない時刻を指定してください"] },
    });
  }
  if (error instanceof InvalidNotificationPreferenceError) {
    // メッセージは項目名のみで入力値を含まない。
    return problemResponse(422, {
      code: "invalid_notification_setting",
      message: "通知設定の内容が不正です",
      fieldErrors: { [error.field]: [error.message] },
    });
  }
  return null;
}

function toResponse(view: NotificationSettingsView): NotificationSettingsResponse {
  return {
    enabled: view.enabled,
    localTime: view.localTime,
    timezone: view.timezone,
    quietHours: view.quietHours === null ? null : { ...view.quietHours },
    updatedAt: view.updatedAt === null ? null : view.updatedAt.toISOString(),
  };
}

export function createNotificationSettingsHandlers(
  deps: NotificationSettingsHandlerDeps,
): NotificationSettingsHandlers {
  async function run(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      const response = mapNotificationError(error);
      if (response === null) throw error;
      return response;
    }
  }

  return {
    async get(request) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      return run(async () => {
        const view = await deps.useCases.get({ actorUserId });
        return jsonResponse(200, toResponse(view));
      });
    },

    async upsert(request) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const parsed = await readJsonBody(request, upsertNotificationSettingsRequestSchema);
      if (!parsed.ok) return parsed.response;

      return run(async () => {
        const view = await deps.useCases.upsert({
          actorUserId,
          enabled: parsed.data.enabled,
          localTime: parsed.data.localTime,
          quietHours: parsed.data.quietHours,
          timezone: parsed.data.timezone,
        });
        return jsonResponse(200, toResponse(view));
      });
    },
  };
}
