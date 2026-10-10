import { createHmac } from "node:crypto";

/**
 * 監査ログに残す IP の不可逆化(HMAC-SHA256、鍵つき)。生の IP を保存・ログしない。
 * IP が取得できない場合は固定値 `unknown` を同じ方法で変換する。
 */
export function createIpHasher(key: string): (ip: string | null) => string {
  if (Buffer.byteLength(key, "utf8") < 32)
    throw new Error("audit ip hash key must be at least 32 bytes");
  return (ip) =>
    createHmac("sha256", key)
      .update(ip ?? "unknown", "utf8")
      .digest("hex");
}
