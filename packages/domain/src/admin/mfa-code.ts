/** リカバリーコードの文字集合。紛らわしい `0 O 1 I` を除いた 32 文字(1 文字あたり 5 ビット)。 */
export const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** リカバリーコードの文字数(ハイフンを除く)。10 文字 = 50 ビット。 */
export const RECOVERY_CODE_LENGTH = 10;

export type ParsedMfaCode =
  | { readonly kind: "totp"; readonly code: string }
  | { readonly kind: "recovery"; readonly code: string };

const TOTP_PATTERN = /^\d{6}$/;
const RECOVERY_BODY_PATTERN = new RegExp(`^[${RECOVERY_CODE_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`);

/** 10 文字のコードを `XXXXX-XXXXX` の表示形式にする。 */
export function formatRecoveryCode(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * MFA コードの入力を正規化して種別を判定する(ADM-003)。
 * 6 桁の数字は TOTP。リカバリーコードは大文字小文字・前後の空白・途中の空白・ハイフンの有無を無視し、
 * 正規形 `XXXXX-XXXXX` に揃える。どちらにも該当しなければ `null`
 * (呼び出し側は理由を区別せず「無効なコード」として扱う)。
 */
export function parseMfaCode(input: unknown): ParsedMfaCode | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const compact = input.replace(/[\s-]/g, "");
  if (TOTP_PATTERN.test(compact)) return { kind: "totp", code: compact };
  const upper = compact.toUpperCase();
  if (RECOVERY_BODY_PATTERN.test(upper))
    return { kind: "recovery", code: formatRecoveryCode(upper) };
  return null;
}
