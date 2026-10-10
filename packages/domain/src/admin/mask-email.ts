/**
 * 管理画面に出す email のマスク(ADM-INV-006)。
 * 先頭 1 文字 + `***` + `@` + ドメイン。ローカル部が 1 文字以下なら `***`(1 文字そのものを出さない)。
 * `@` を含まない値は全体を `***` にする。ローカル部はマスクから復元できない。
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = [...local].length > 1 ? [...local][0] : "";
  return `${visible}***@${domain}`;
}
