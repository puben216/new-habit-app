/**
 * 管理画面の表示用の整形(docs/specs/admin-screens.md ADS-008)。
 * 日時は利用者の端末の timezone に依存させず、UTC の固定書式で表示する。
 */

const ISO_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

/** ISO 8601(UTC)の日時を `YYYY-MM-DD HH:mm UTC` にする。形式が想定外なら元の文字列は出さず「不明」。 */
export function formatUtc(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "不明";
  const match = ISO_PATTERN.exec(new Date(time).toISOString());
  return match === null ? "不明" : `${match[1]} ${match[2]} UTC`;
}

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
