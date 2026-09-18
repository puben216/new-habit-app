import { createHash, randomBytes } from "node:crypto";
import type { TokenGeneratorPort } from "@habit-app/application";

const TOKEN_BYTES = 32;

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * verification/reset token 用の TokenGeneratorPort 実装(Plan: CryptoTokenGenerator)。
 * 平文は発行直後の通知にのみ使い、保存には sha256 hash を用いる(Business Rules 準拠)。
 */
export function createCryptoTokenGenerator(): TokenGeneratorPort {
  return {
    generate() {
      const plaintext = randomBytes(TOKEN_BYTES).toString("hex");
      return { plaintext, hash: hashToken(plaintext) };
    },
    hash(plaintext: string): string {
      return hashToken(plaintext);
    },
  };
}
