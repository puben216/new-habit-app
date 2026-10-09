import {
  dailyCheckInResponseSchema,
  habitEntryResponseSchema,
  todayScheduleResponseSchema,
  type DailyCheckInResponse,
  type HabitEntryResponse,
  type TodayScheduleResponse,
  type UpsertDailyCheckInRequest,
  type UpsertHabitEntryRequest,
} from "@habit-app/contracts";

import { isApiError } from "@/lib/api/api-error";
import { apiRequest } from "@/lib/api/client";

export const scheduleKey = (date: string | "today") => ["schedule", date] as const;
export const checkInKey = (date: string) => ["check-in", date] as const;
export const SCHEDULE_ROOT_KEY = ["schedule"] as const;

export function getSchedule(
  date: string | "today",
  signal?: AbortSignal,
): Promise<TodayScheduleResponse> {
  return apiRequest({
    path: date === "today" ? "/api/v1/schedule/today" : `/api/v1/schedule/${date}`,
    schema: todayScheduleResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function putEntry(
  habitId: string,
  date: string,
  body: UpsertHabitEntryRequest,
): Promise<HabitEntryResponse> {
  return apiRequest({
    method: "PUT",
    path: `/api/v1/habits/${encodeURIComponent(habitId)}/entries/${date}`,
    schema: habitEntryResponseSchema,
    body,
  });
}

/** 未記録(404 check_in_not_found)は `null`。それ以外の失敗は投げる。 */
export async function getCheckIn(
  date: string,
  signal?: AbortSignal,
): Promise<DailyCheckInResponse | null> {
  try {
    return await apiRequest({
      path: `/api/v1/daily-check-ins/${date}`,
      schema: dailyCheckInResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (isApiError(error) && error.status === 404 && error.code === "check_in_not_found")
      return null;
    throw error;
  }
}

export function putCheckIn(
  date: string,
  body: UpsertDailyCheckInRequest,
): Promise<DailyCheckInResponse> {
  return apiRequest({
    method: "PUT",
    path: `/api/v1/daily-check-ins/${date}`,
    schema: dailyCheckInResponseSchema,
    body,
  });
}
