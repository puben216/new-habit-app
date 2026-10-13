import { z } from "zod";

/**
 * `/api/v1/me/exports*` と、データエクスポートの queue message の契約
 * (docs/specs/data-export.md APIとイベント節)。runtime schema を正本とし、型は z.infer で導出する(ADR-009)。
 * request は `.strict()` で未知キーを拒否する。
 */

/** `POST /me/exports` の body 上限(バイト)。パスワードと形式のみのため小さい。 */
export const DATA_EXPORT_REQUEST_MAX_BODY_BYTES = 1024;

export const DATA_EXPORT_FORMAT_VALUES = ["json", "csv"] as const;
export const DATA_EXPORT_STATUS_VALUES = [
  "queued",
  "running",
  "ready",
  "failed",
  "expired",
] as const;

export const createDataExportRequestSchema = z
  .object({
    // AUTH-002 のパスワード上限と同じ。形式の詳細は検証せず、ハッシュの照合に任せる。
    password: z.string().min(1).max(128),
    format: z.enum(DATA_EXPORT_FORMAT_VALUES),
  })
  .strict();
export type CreateDataExportRequest = z.infer<typeof createDataExportRequestSchema>;

/** エクスポート 1 件。`id` は公開 ID で、内部 ID・user ID・ファイル名・成果物は含まない。 */
export const dataExportResponseSchema = z.object({
  id: z.uuid(),
  status: z.enum(DATA_EXPORT_STATUS_VALUES),
  format: z.enum(DATA_EXPORT_FORMAT_VALUES),
  requestedAt: z.iso.datetime(),
  /** `ready` のみ。期限を過ぎたものは `expired` として返すため、`expired` でも残る。 */
  expiresAt: z.iso.datetime().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  /** `failed` のみ。理由コードで、データの内容・例外メッセージを含まない。 */
  failureCode: z.string().nullable(),
});
export type DataExportResponse = z.infer<typeof dataExportResponseSchema>;

export const dataExportListResponseSchema = z.object({ items: z.array(dataExportResponseSchema) });
export type DataExportListResponse = z.infer<typeof dataExportListResponseSchema>;

/** queue message。job の公開 ID のみで、個人情報・データの内容を含めない(EXP-INV-007)。 */
export const dataExportMessageV1Schema = z
  .object({ version: z.literal(1), exportId: z.uuid() })
  .strict();
export type DataExportMessageV1 = z.infer<typeof dataExportMessageV1Schema>;
