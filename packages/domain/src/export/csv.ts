/**
 * CSV の組み立て(docs/specs/data-export.md EXP-006)。
 * 表計算ソフトが数式として実行しうる文字列を無害化し、RFC 4180 に沿ってエスケープする。
 */

export type CsvValue = string | number | boolean | null | undefined | CsvJson;
/** 入れ子の値(`summary`、`result`、`daysOfWeek` など)。JSON 文字列として 1 セルに入れる。 */
export type CsvJson = readonly CsvValue[] | { readonly [key: string]: CsvValue };

/** セルの先頭がこれらの文字のとき、表計算ソフトが数式・コマンドとして解釈しうる。 */
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** 文字列セルが数式として実行されうるなら、先頭に `'` を付ける。数値型の値(負数を含む)は対象外。 */
export function neutralizeFormula(text: string): string {
  const first = text.charAt(0);
  return first !== "" && FORMULA_PREFIXES.has(first) ? `'${text}` : text;
}

function needsQuoting(text: string): boolean {
  return /[",\r\n]/.test(text);
}

/** 1 セルを CSV の文字列にする。`null`/`undefined` は空、数値・真偽値は文字列化のみ。 */
export function toCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";

  const text = neutralizeFormula(typeof value === "string" ? value : JSON.stringify(value));
  return needsQuoting(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CRLF = "\r\n";

/** ヘッダー行 + データ行。改行は CRLF。BOM は付けない(ファイル化する側で付ける)。 */
export function toCsv(columns: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [columns.map((column) => toCsvCell(column)).join(",")];
  for (const row of rows) lines.push(row.map((cell) => toCsvCell(cell)).join(","));
  return lines.join(CRLF) + CRLF;
}
