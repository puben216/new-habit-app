/**
 * メールのリンクの token を扱う画面の共通処理(docs/specs/auth-screens.md AUI-003、AUI-006、AUI-INV-004)。
 */

/** 送信後に URL から token(query)を取り除く。履歴・Referer への残存を減らす。 */
export function stripQueryFromUrl(): void {
  window.history.replaceState(null, "", window.location.pathname);
}
