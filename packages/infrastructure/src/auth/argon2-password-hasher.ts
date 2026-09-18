import * as argon2 from "argon2";
import type { PasswordHasherPort } from "@habit-app/application";

/**
 * PasswordHasherPort 実装(Plan: Argon2PasswordHasher)。argon2id を用いる(ADR-001)。
 */
export function createArgon2PasswordHasher(): PasswordHasherPort {
  return {
    async hash(password: string): Promise<string> {
      return argon2.hash(password, { type: argon2.argon2id });
    },
    async verify(password: string, hash: string): Promise<boolean> {
      try {
        return await argon2.verify(hash, password);
      } catch {
        // hash が argon2 形式でない(破損データ等)場合も検証失敗として扱う。
        return false;
      }
    },
  };
}

/**
 * AUTH-INV-002(処理時間差の排除)のため、email 不存在時に login use case が
 * 検証するダミーハッシュ。起動時に一度だけ生成し、リクエストごとに計算し直さない。
 */
const DUMMY_PASSWORD = "dummy-password-for-timing-safety";

export async function createDummyPasswordHash(hasher: PasswordHasherPort): Promise<string> {
  return hasher.hash(DUMMY_PASSWORD);
}
