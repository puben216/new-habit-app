/**
 * データエクスポートの業務ルール(docs/specs/data-export.md)。
 * 期限は UTC の経過時間で決め、ローカル日付やタイムゾーンに依存しない(EXP-INV-005)。
 */

export const DATA_EXPORT_FORMATS = ["json", "csv"] as const;
export type DataExportFormat = (typeof DATA_EXPORT_FORMATS)[number];

export function isDataExportFormat(value: unknown): value is DataExportFormat {
  return typeof value === "string" && (DATA_EXPORT_FORMATS as readonly string[]).includes(value);
}

/** DB の CHECK `data_exports_status_check` と同じ値域。 */
export const DATA_EXPORT_STATUSES = ["queued", "running", "ready", "failed", "expired"] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

export function isDataExportStatus(value: unknown): value is DataExportStatus {
  return typeof value === "string" && (DATA_EXPORT_STATUSES as readonly string[]).includes(value);
}

/** 完成から、ダウンロードできる期間(時間)。この定数が唯一の定義。 */
export const DATA_EXPORT_TTL_HOURS = 24;
/** 成果物の上限(バイト)。超えたら生成を失敗にし、部分的なファイルを保存しない(EXP-INV-008)。 */
export const DATA_EXPORT_MAX_BYTES = 20 * 1024 * 1024;
/** 直近 24 時間に作成できるエクスポートの件数(失敗・期限切れを含む)。 */
export const DATA_EXPORT_DAILY_LIMIT = 5;
export const DATA_EXPORT_RATE_WINDOW_HOURS = 24;
/** worker の受信回数の上限。一時的な失敗はこの回数まで再配送し、超えたら `worker_error`。 */
export const DATA_EXPORT_MAX_RECEIVE = 3;
/** `running` の lease(秒)。これを過ぎた `running` は別の worker が再 claim できる。 */
export const DATA_EXPORT_LEASE_SECONDS = 300;
/** `queued`/`running` のまま、これだけ更新されない job は停止したとみなして失敗にする(分)。 */
export const DATA_EXPORT_STALE_MINUTES = 60;
/** 定期ジョブが 1 回に処理する最大件数。 */
export const DATA_EXPORT_CLEANUP_BATCH_SIZE = 200;
/** `failed`/`expired` の行を残す日数(`updated_at` 基準)。 */
export const DATA_EXPORT_RETENTION_DAYS = 7;
/** 一覧で返す件数。 */
export const DATA_EXPORT_LIST_LIMIT = 5;
/** 収集で、記録・チェックインを分割して読み込む件数。 */
export const DATA_EXPORT_READ_CHUNK_SIZE = 5000;

/** 失敗の理由コード。データの内容・例外メッセージを含めない。 */
export const DATA_EXPORT_FAILURE_CODES = [
  "too_large",
  "generation_failed",
  "worker_error",
  "enqueue_failed",
] as const;
export type DataExportFailureCode = (typeof DATA_EXPORT_FAILURE_CODES)[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 完成時刻から期限(`completedAt + 24 時間`)。 */
export function exportExpiresAt(completedAt: Date): Date {
  return new Date(completedAt.getTime() + DATA_EXPORT_TTL_HOURS * HOUR_MS);
}

/** 期限に達したか(`now >= expiresAt`)。ダウンロードの可否・表示・定期ジョブの対象判定が共有する。 */
export function isExportExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/** 作成頻度の数え始め(`now - 24 時間`)。この時刻以降の作成を数える。 */
export function exportRateWindowStart(now: Date): Date {
  return new Date(now.getTime() - DATA_EXPORT_RATE_WINDOW_HOURS * HOUR_MS);
}

/** この時刻以前から更新されていない `queued`/`running` は停止したとみなす(EXP-001/007)。 */
export function exportStaleCutoff(now: Date): Date {
  return new Date(now.getTime() - DATA_EXPORT_STALE_MINUTES * 60 * 1000);
}

/** `failed`/`expired` の行を削除する基準時刻(`updated_at <= この時刻` が対象)。 */
export function exportRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - DATA_EXPORT_RETENTION_DAYS * DAY_MS);
}

/** 監査 action(EXP-INV-009)。内容・識別情報を含めない。 */
export const EXPORT_AUDIT_ACTIONS = ["user.export.requested", "user.export.downloaded"] as const;
export type ExportAuditAction = (typeof EXPORT_AUDIT_ACTIONS)[number];

/** 形式ごとの Content-Type とファイル名の拡張子。ファイル名にユーザー入力を含めない(EXP-004)。 */
export function exportFileInfo(
  format: DataExportFormat,
  completedAt: Date,
): { readonly contentType: string; readonly fileName: string } {
  const yyyymmdd = completedAt.toISOString().slice(0, 10).replaceAll("-", "");
  return format === "json"
    ? {
        contentType: "application/json; charset=utf-8",
        fileName: `habit-app-export-${yyyymmdd}.json`,
      }
    : { contentType: "application/zip", fileName: `habit-app-export-${yyyymmdd}.zip` };
}
