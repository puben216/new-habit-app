import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";

/**
 * データエクスポート画面の固定文言(docs/specs/data-export.md EXP-008、WUI-INV-003:
 * server の文字列は描画しない)。
 */
export const EXPORT_PASSWORD_REQUIRED_MESSAGE = "パスワードを入力してください。";
export const EXPORT_REAUTH_FAILED_MESSAGE =
  "パスワードが正しくありません。もう一度入力してください。";
export const EXPORT_TOO_MANY_ATTEMPTS_MESSAGE =
  "試行回数の上限に達しました。しばらく待ってからもう一度お試しください。";
export const EXPORT_IN_PROGRESS_MESSAGE =
  "作成中のエクスポートがあります。完成してから、もう一度お試しください。";
export const EXPORT_RATE_LIMITED_MESSAGE =
  "エクスポートを作成できる回数の上限に達しました。しばらく待ってからお試しください(24 時間に 5 回までです)。";
export const EXPORT_UNAVAILABLE_MESSAGE =
  "エクスポートを開始できませんでした。時間をおいてもう一度お試しください。";
export const EXPORT_NETWORK_MESSAGE = "通信に失敗しました。時間をおいてもう一度お試しください。";
export const EXPORT_UNEXPECTED_MESSAGE =
  "処理を完了できませんでした。時間をおいてもう一度お試しください。";
export const EXPORT_STARTED_MESSAGE =
  "エクスポートの作成を開始しました。完成するとダウンロードできます。";

export type ExportErrorKind =
  | "reauth_failed"
  | "too_many_attempts"
  | "in_progress"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "unexpected";

/** API 失敗の分類。使うのは status と code だけで、server の文字列は使わない。 */
export function classifyExportError(error: unknown): ExportErrorKind {
  if (!isApiError(error)) return "unexpected";
  if (error.code === CLIENT_ERROR_CODES.networkError) return "network";
  if (error.status === 403 && error.code === "reauthentication_failed") return "reauth_failed";
  if (error.status === 429 && error.code === "too_many_attempts") return "too_many_attempts";
  if (error.status === 429 && error.code === "export_rate_limited") return "rate_limited";
  if (error.status === 409 && error.code === "export_in_progress") return "in_progress";
  if (error.status === 503) return "unavailable";
  return "unexpected";
}

export function exportErrorMessage(kind: ExportErrorKind): string {
  switch (kind) {
    case "reauth_failed":
      return EXPORT_REAUTH_FAILED_MESSAGE;
    case "too_many_attempts":
      return EXPORT_TOO_MANY_ATTEMPTS_MESSAGE;
    case "in_progress":
      return EXPORT_IN_PROGRESS_MESSAGE;
    case "rate_limited":
      return EXPORT_RATE_LIMITED_MESSAGE;
    case "unavailable":
      return EXPORT_UNAVAILABLE_MESSAGE;
    case "network":
      return EXPORT_NETWORK_MESSAGE;
    case "unexpected":
      return EXPORT_UNEXPECTED_MESSAGE;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: "待機中",
  running: "作成中",
  ready: "ダウンロードできます",
  failed: "作成に失敗しました",
  expired: "期限が切れました",
};

/** 状態コードの日本語ラベル。未知のコードはそのまま返す(情報を落とさない)。 */
export function exportStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function exportFormatLabel(format: string): string {
  return format === "json" ? "JSON" : format === "csv" ? "CSV(ZIP)" : format;
}

/** 失敗の理由コードの説明。データの内容は含まない。未知のコードは汎用の文言。 */
export function exportFailureMessage(code: string | null): string {
  if (code === "too_large") return "データが大きすぎて作成できませんでした。";
  return "作成できませんでした。もう一度お試しください。";
}

/** `queued`/`running` の間は状態を更新し続ける。 */
export function isExportActive(status: string): boolean {
  return status === "queued" || status === "running";
}

/** バイト数を読みやすくする(1 KB = 1024 バイト)。 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} バイト`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
