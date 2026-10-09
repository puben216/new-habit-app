import { profileResponseSchema, type ProfileResponse } from "@habit-app/contracts";

import { apiRequest } from "@/lib/api/client";

export const PROFILE_QUERY_KEY = ["me"] as const;

export function fetchProfile(signal?: AbortSignal): Promise<ProfileResponse> {
  return apiRequest({
    path: "/api/v1/me",
    schema: profileResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface ProfileChanges {
  readonly displayName: string;
  readonly timezone: string;
  readonly weekStartsOn: number;
}

export function updateProfile(changes: ProfileChanges): Promise<ProfileResponse> {
  return apiRequest({
    method: "PATCH",
    path: "/api/v1/me",
    schema: profileResponseSchema,
    body: changes,
  });
}
