import { createHmac, timingSafeEqual } from "node:crypto";
import type { UnsubscribeTokenPort } from "@habit-app/application";
import { UUID_PATTERN } from "./shared";

/**
 * 配信停止 token の署名・検証(docs/specs/notification-delivery.md NDL-007)。
 * 形式: `v1.{base64url(payload)}.{base64url(HMAC-SHA256)}`。payload は用途と公開 ID のみで、
 * 内部 ID・email を含めない。検証は定数時間比較で、不正な理由(形式・署名・用途)を区別しない。
 */
const VERSION = "v1";
const PURPOSE = "reminder-unsubscribe";
const MIN_KEY_BYTES = 32;
const MAX_TOKEN_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function createHmacUnsubscribeTokenSigner(signingKey: string): UnsubscribeTokenPort {
  if (Buffer.byteLength(signingKey, "utf8") < MIN_KEY_BYTES) {
    throw new Error("unsubscribe signing key must be at least 32 bytes");
  }
  const sign = (data: string) => createHmac("sha256", signingKey).update(data).digest();

  return {
    issue(userPublicId) {
      const payload = Buffer.from(JSON.stringify({ purpose: PURPOSE, sub: userPublicId })).toString(
        "base64url",
      );
      const signature = sign(`${VERSION}.${payload}`).toString("base64url");
      return `${VERSION}.${payload}.${signature}`;
    },

    verify(token) {
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
      const parts = token.split(".");
      const [version, payload, signature] = parts;
      if (
        parts.length !== 3 ||
        version !== VERSION ||
        payload === undefined ||
        signature === undefined
      ) {
        return null;
      }
      if (!BASE64URL.test(payload) || !BASE64URL.test(signature)) return null;

      const expected = sign(`${VERSION}.${payload}`);
      const actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      // base64url の未使用ビットだけが異なる別表現を受理しない(同じ token の表現を 1 つに限る)。
      if (actual.toString("base64url") !== signature) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (typeof parsed !== "object" || parsed === null) return null;
      const { purpose, sub } = parsed as { purpose?: unknown; sub?: unknown };
      if (purpose !== PURPOSE || typeof sub !== "string" || !UUID_PATTERN.test(sub)) return null;
      return sub;
    },
  };
}
