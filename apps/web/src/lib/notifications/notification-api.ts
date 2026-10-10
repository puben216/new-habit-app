import {
  notificationSettingsResponseSchema,
  type NotificationSettingsResponse,
  type UpsertNotificationSettingsRequest,
} from "@habit-app/contracts";

import { apiRequest } from "@/lib/api/client";

export const NOTIFICATION_QUERY_KEY = ["notification-settings"] as const;

export function fetchNotificationSettings(
  signal?: AbortSignal,
): Promise<NotificationSettingsResponse> {
  return apiRequest({
    path: "/api/v1/notification-settings",
    schema: notificationSettingsResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function putNotificationSettings(
  body: UpsertNotificationSettingsRequest,
): Promise<NotificationSettingsResponse> {
  return apiRequest({
    method: "PUT",
    path: "/api/v1/notification-settings",
    schema: notificationSettingsResponseSchema,
    body,
  });
}
