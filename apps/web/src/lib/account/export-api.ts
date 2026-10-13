import {
  dataExportListResponseSchema,
  dataExportResponseSchema,
  type DataExportListResponse,
  type DataExportResponse,
} from "@habit-app/contracts";

import { apiRequest } from "@/lib/api/client";

/**
 * データエクスポートの型付き client(docs/specs/data-export.md)。パスワードは body にだけ載せ、
 * queryKey・URL・storage には載せない。ダウンロードは API の URL への通常のリンク(session の cookie で認可される)。
 */

export const dataExportsQueryKey = ["account", "exports"] as const;

export function createDataExport(
  password: string,
  format: "json" | "csv",
): Promise<DataExportResponse> {
  return apiRequest({
    method: "POST",
    path: "/api/v1/me/exports",
    schema: dataExportResponseSchema,
    body: { password, format },
  });
}

export function listDataExports(signal?: AbortSignal): Promise<DataExportListResponse> {
  return apiRequest({
    path: "/api/v1/me/exports",
    schema: dataExportListResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** ダウンロードのリンク先。`id` は API が返した公開 ID(UUID)だけを受け付ける。 */
export function dataExportDownloadPath(id: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? `/api/v1/me/exports/${id}/download`
    : null;
}
