import { createHash, randomBytes } from "node:crypto";
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
  formatRecoveryCode,
} from "@habit-app/domain";

/**
 * リカバリーコードの生成とハッシュ(docs/specs/minimal-admin.md ADM-INV-007)。
 * 32 文字の集合に対し、乱数 1 バイトの下位 5 ビットを使う(256 は 32 で割り切れるので偏りがない)。
 * 10 文字 = 50 ビットで、保存は SHA-256 のハッシュのみ(高エントロピーなので salt/低速ハッシュは不要)。
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let raw = "";
  for (const byte of bytes) raw += RECOVERY_CODE_ALPHABET[byte & 31];
  return formatRecoveryCode(raw);
}

/** 正規形(`XXXXX-XXXXX`)のコードのハッシュ。 */
export function hashRecoveryCode(canonicalCode: string): string {
  return createHash("sha256").update(canonicalCode, "utf8").digest("hex");
}

export function generateRecoveryCodes(count: number): {
  readonly codes: readonly string[];
  readonly hashes: readonly string[];
} {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  const list = [...codes];
  return { codes: list, hashes: list.map(hashRecoveryCode) };
}
