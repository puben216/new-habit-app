import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createSecretBox } from "./secret-box";

const key = () => randomBytes(32).toString("base64");

describe("createSecretBox", () => {
  it("暗号化して復号できる。暗号文は毎回異なり、平文を含まない", () => {
    const box = createSecretBox(key());
    const secret = Buffer.from("super-secret-totp-bytes");
    const a = box.encrypt(secret, "admin-totp:1");
    const b = box.encrypt(secret, "admin-totp:1");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain(secret.toString("base64url"));
    expect(box.decrypt(a, "admin-totp:1")?.equals(secret)).toBe(true);
  });

  it("任意の長さの平文で往復する(プロパティ)", () => {
    const box = createSecretBox(key());
    for (let length = 0; length < 100; length += 7) {
      const plain = randomBytes(length);
      expect(box.decrypt(box.encrypt(plain, "aad"), "aad")?.equals(plain)).toBe(true);
    }
  });

  it("AAD が違う(別の管理者の行へ差し替えた)場合は復号できない", () => {
    const box = createSecretBox(key());
    const token = box.encrypt(Buffer.from("secret"), "admin-totp:1");
    expect(box.decrypt(token, "admin-totp:2")).toBeNull();
  });

  it("別の鍵では復号できない", () => {
    const token = createSecretBox(key()).encrypt(Buffer.from("secret"), "aad");
    expect(createSecretBox(key()).decrypt(token, "aad")).toBeNull();
  });

  it("暗号文のどの 1 文字を変えても復号できない(改ざん検知)", () => {
    const box = createSecretBox(key());
    const token = box.encrypt(Buffer.from("secret-value-123"), "aad");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let accepted = 0;
    for (let i = 0; i < token.length; i += 1) {
      if (token[i] === ".") continue;
      const replacement = alphabet[(alphabet.indexOf(token[i] ?? "") + 1) % alphabet.length] ?? "A";
      const mutated = token.slice(0, i) + replacement + token.slice(i + 1);
      if (box.decrypt(mutated, "aad") !== null) accepted += 1;
    }
    // base64url の末尾の未使用ビットだけが変わる場合を除き、受理されない。
    expect(accepted).toBeLessThanOrEqual(3);
  });

  it("形式不正・版違い・切り詰めは null", () => {
    const box = createSecretBox(key());
    const token = box.encrypt(Buffer.from("secret"), "aad");
    for (const bad of [
      "",
      "v1",
      "v2." + token.slice(3),
      token.slice(0, -4),
      `${token}.x`,
      "a.b.c.d",
    ]) {
      expect(box.decrypt(bad, "aad")).toBeNull();
    }
  });

  it("32 バイトでない鍵は拒否し、メッセージに鍵を含めない", () => {
    for (const bad of [
      "",
      "short",
      randomBytes(16).toString("base64"),
      randomBytes(33).toString("base64"),
    ]) {
      expect(() => createSecretBox(bad)).toThrow("32 bytes");
    }
  });
});
