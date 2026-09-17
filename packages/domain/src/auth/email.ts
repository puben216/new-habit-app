/**
 * email を照合・保存用に正規化する(docs/specs/auth-adapter.md Business Rules)。
 *
 * 前後の空白を除去し、local part・domain part を区別せず全体を小文字化した上で
 * Unicode 正規化(NFC)する。Gmail 固有の dot 除去・plus タグ除去は行わない。
 * IDN(国際化ドメイン名)の punycode 変換も行わない。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().normalize("NFC");
}
