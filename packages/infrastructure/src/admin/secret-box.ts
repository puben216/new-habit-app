import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 保存する秘密(TOTP の秘密)の暗号化(AES-256-GCM)。docs/specs/minimal-admin.md ADM-INV-007。
 * 形式: `v1.{iv}.{暗号文}.{認証タグ}`(各 base64url)。認証付き追加データ(AAD)に所有者の識別子を
 * 含めるので、別の管理者の行へ暗号文を差し替えても復号できない。鍵・平文をエラーに含めない。
 */
const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface SecretBox {
  encrypt(plaintext: Buffer, aad: string): string;
  /** 復号できなければ `null`(改ざん・別の AAD・形式不正・鍵違いを区別しない)。 */
  decrypt(token: string, aad: string): Buffer | null;
}

/** `keyBase64` は 32 バイトの鍵を base64 にしたもの。 */
export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) throw new Error("encryption key must be 32 bytes (base64)");

  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString("base64url"),
        ciphertext.toString("base64url"),
        tag.toString("base64url"),
      ].join(".");
    },

    decrypt(token, aad) {
      const parts = token.split(".");
      const [version, ivText, ciphertextText, tagText] = parts;
      if (
        parts.length !== 4 ||
        version !== VERSION ||
        ivText === undefined ||
        ciphertextText === undefined ||
        tagText === undefined
      ) {
        return null;
      }
      try {
        const iv = Buffer.from(ivText, "base64url");
        const tag = Buffer.from(tagText, "base64url");
        if (iv.length !== IV_BYTES || tag.length !== 16) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertextText, "base64url")),
          decipher.final(),
        ]);
      } catch {
        return null;
      }
    },
  };
}
