import type { AdminCryptoPort } from "@habit-app/application";
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from "./totp";
import { createSecretBox } from "./secret-box";
import { generateRecoveryCodes, hashRecoveryCode } from "./recovery-codes";

const ISSUER = "Habit App Admin";

/** AdminCryptoPort の実装。TOTP の秘密は所有ユーザーの ID を AAD にして暗号化する。 */
export function createAdminCrypto(encryptionKeyBase64: string): AdminCryptoPort {
  const box = createSecretBox(encryptionKeyBase64);
  const aad = (userId: string) => `admin-totp:${userId}`;

  return {
    enrollTotp({ userId, accountLabel }) {
      const secret = generateTotpSecret();
      return {
        encryptedSecret: box.encrypt(secret, aad(userId)),
        otpauthUri: buildOtpauthUri({ secret, issuer: ISSUER, accountLabel }),
      };
    },

    verifyTotp({ userId, encryptedSecret, code, nowMs, lastStep }) {
      const secret = box.decrypt(encryptedSecret, aad(userId));
      if (secret === null) return null;
      return verifyTotp({ secret, code, nowMs, lastStep });
    },

    generateRecoveryCodes,
    hashRecoveryCode,
  };
}
