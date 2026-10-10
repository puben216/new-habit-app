import { dashboardResponseSchema, type DashboardResponse } from "@habit-app/contracts";

import { apiRequest } from "@/lib/api/client";

export const DASHBOARD_QUERY_KEY = ["dashboard"] as const;

export function fetchDashboard(signal?: AbortSignal): Promise<DashboardResponse> {
  return apiRequest({
    path: "/api/v1/dashboard",
    schema: dashboardResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}
