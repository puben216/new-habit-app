/**
 * 管理画面の表示用の整形(docs/specs/admin-screens.md ADS-008)。
 * 日時は利用者の端末の timezone に依存させず、UTC の固定書式で表示する。
 */

export { formatUtc } from "@/lib/format/utc";

const STATUS_LABEL: Readonly<Record<string, string>> = {
  failed: "失敗",
  expired: "期限切れ",
  suppressed: "配信停止",
  fallback: "フォールバック",
  active: "有効",
  disabled: "無効",
  deletion_pending: "削除待ち",
  suspended: "停止中",
  pending: "待機中",
  sent: "送信済み",
  succeeded: "成功",
  queued: "待機中",
  running: "実行中",
};

/** 状態コードの日本語ラベル。未知のコードはコード値をそのまま返す(情報を落とさない)。 */
export function statusLabel(code: string): string {
  return STATUS_LABEL[code] ?? code;
}

/** 件数の対応(`{ failed: 2, sent: 5 }`)をコード順の配列にする。 */
export function sortedCounts(counts: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
}
