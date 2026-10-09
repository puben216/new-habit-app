import {
  habitListResponseSchema,
  habitResponseSchema,
  type CreateHabitRequest,
  type HabitListResponse,
  type HabitResponse,
  type UpdateHabitRequest,
} from "@habit-app/contracts";

import { apiRequest } from "@/lib/api/client";

export type HabitStatusFilter = "active" | "archived";

export const habitsQueryKey = (status: HabitStatusFilter) => ["habits", "list", status] as const;
export const habitQueryKey = (habitId: string) => ["habits", "detail", habitId] as const;
export const HABITS_ROOT_KEY = ["habits"] as const;

export function listHabits(
  status: HabitStatusFilter,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<HabitListResponse> {
  const params = new URLSearchParams({ status });
  if (cursor !== undefined) params.set("cursor", cursor);
  return apiRequest({
    path: `/api/v1/habits?${params.toString()}`,
    schema: habitListResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getHabit(habitId: string, signal?: AbortSignal): Promise<HabitResponse> {
  return apiRequest({
    path: `/api/v1/habits/${encodeURIComponent(habitId)}`,
    schema: habitResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createHabit(body: CreateHabitRequest): Promise<HabitResponse> {
  return apiRequest({ method: "POST", path: "/api/v1/habits", schema: habitResponseSchema, body });
}

export function updateHabit(habitId: string, body: UpdateHabitRequest): Promise<HabitResponse> {
  return apiRequest({
    method: "PATCH",
    path: `/api/v1/habits/${encodeURIComponent(habitId)}`,
    schema: habitResponseSchema,
    body,
  });
}

export function archiveHabit(habitId: string, version: number): Promise<HabitResponse> {
  return apiRequest({
    method: "POST",
    path: `/api/v1/habits/${encodeURIComponent(habitId)}/archive`,
    schema: habitResponseSchema,
    body: { version },
  });
}
