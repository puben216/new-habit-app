import {
  adminAiJobFailuresResponseSchema,
  adminMeResponseSchema,
  adminMfaVerifyResponseSchema,
  adminNotificationFailuresResponseSchema,
  adminUserOverviewResponseSchema,
  adminUserSearchResponseSchema,
  type AdminAiJobFailuresResponse,
  type AdminMeResponse,
  type AdminMfaVerifyResponse,
  type AdminNotificationFailuresResponse,
  type AdminUserOverviewResponse,
  type AdminUserSearchResponse,
} from "@habit-app/contracts";

import { apiRequest } from "@/lib/api/client";

/**
 * `/api/v1/admin/*` の型付き client(docs/specs/admin-screens.md)。read-only の GET と MFA 検証の POST のみ
 * (ADS-INV-005)。検索の email は query に載せるが、画面の URL・queryKey には含めない(ADS-INV-003)。
 */

export const adminMeQueryKey = ["admin", "me"] as const;
export const adminUserQueryKey = (publicId: string) => ["admin", "user", publicId] as const;
export const adminNotificationsQueryKey = (status: string | undefined) =>
  ["admin", "notifications", status ?? "all"] as const;
export const adminAiJobsQueryKey = (status: string | undefined) =>
  ["admin", "ai-jobs", status ?? "all"] as const;

/** 管理データはブラウザの cache に残さない(ADS-008)。 */
export const ADMIN_QUERY_OPTIONS = { gcTime: 0 } as const;

export function verifyMfa(code: string): Promise<AdminMfaVerifyResponse> {
  return apiRequest({
    method: "POST",
    path: "/api/v1/admin/mfa/verify",
    schema: adminMfaVerifyResponseSchema,
    body: { code },
  });
}

export function getAdminMe(signal?: AbortSignal): Promise<AdminMeResponse> {
  return apiRequest({
    path: "/api/v1/admin/me",
    schema: adminMeResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function searchUsers(email: string): Promise<AdminUserSearchResponse> {
  const params = new URLSearchParams({ email });
  return apiRequest({
    path: `/api/v1/admin/users?${params.toString()}`,
    schema: adminUserSearchResponseSchema,
  });
}

export function getAdminUser(
  publicId: string,
  signal?: AbortSignal,
): Promise<AdminUserOverviewResponse> {
  return apiRequest({
    path: `/api/v1/admin/users/${encodeURIComponent(publicId)}`,
    schema: adminUserOverviewResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

function listPath(base: string, status: string | undefined, cursor: string | undefined): string {
  const params = new URLSearchParams();
  if (status !== undefined) params.set("status", status);
  if (cursor !== undefined) params.set("cursor", cursor);
  const query = params.toString();
  return query === "" ? base : `${base}?${query}`;
}

export function listNotificationFailures(
  status: string | undefined,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<AdminNotificationFailuresResponse> {
  return apiRequest({
    path: listPath("/api/v1/admin/operations/notifications", status, cursor),
    schema: adminNotificationFailuresResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function listAiJobFailures(
  status: string | undefined,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<AdminAiJobFailuresResponse> {
  return apiRequest({
    path: listPath("/api/v1/admin/operations/ai-jobs", status, cursor),
    schema: adminAiJobFailuresResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}
