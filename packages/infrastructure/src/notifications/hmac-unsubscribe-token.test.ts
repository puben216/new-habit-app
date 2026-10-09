import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createHmacUnsubscribeTokenSigner } from "./hmac-unsubscribe-token";

const KEY = "test-signing-key-0123456789-abcdefghijkl";
const OTHER_KEY = "another-signing-key-0123456789-abcdefghi";
const PUBLIC_ID = "3f2b8c1e-5a47-4d9e-8c36-1b2a9e7d4f10";

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomUuid(random: () => number): string {
  const hex = () =>
    Array.from({ length: 4 }, () =>
      Math.floor(random() * 65536)
        .toString(16)
        .padStart(4, "0"),
    ).join("");
  const h = hex() + hex();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 署名鍵を知る者が作った、用途や sub が異なる token(署名は正しい)。 */
function forge(key: string, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(`v1.${encoded}`).digest("base64url");
  return `v1.${encoded}.${signature}`;
}

describe("createHmacUnsubscribeTokenSigner", () => {
  const signer = createHmacUnsubscribeTokenSigner(KEY);

  it("発行した token は検証でき、公開 ID が戻る。token に内部情報・email は含まれない", () => {
    const token = signer.issue(PUBLIC_ID);
    expect(signer.verify(token)).toBe(PUBLIC_ID);
    const payload = Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8");
    expect(JSON.parse(payload)).toEqual({ purpose: "reminder-unsubscribe", sub: PUBLIC_ID });
  });

  it("任意の公開 ID で往復する(プロパティ)", () => {
    const random = createRandom(402);
    for (let i = 0; i < 300; i += 1) {
      const id = randomUuid(random);
      expect(signer.verify(signer.issue(id))).toBe(id);
    }
  });

  it("別の鍵で署名された token は拒否する", () => {
    expect(createHmacUnsubscribeTokenSigner(OTHER_KEY).verify(signer.issue(PUBLIC_ID))).toBeNull();
  });

  it("token のどの 1 文字を変えても検証に通らない(改ざん検知のプロパティ)", () => {
    const token = signer.issue(PUBLIC_ID);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    for (let i = 0; i < token.length; i += 1) {
      if (token[i] === ".") continue;
      const replacement = alphabet[(alphabet.indexOf(token[i] ?? "") + 1) % alphabet.length] ?? "A";
      const mutated = token.slice(0, i) + replacement + token.slice(i + 1);
      expect(signer.verify(mutated)).toBeNull();
    }
  });

  it("切り詰め・連結・空・長すぎる・区切りの過不足・版違いを拒否する", () => {
    const token = signer.issue(PUBLIC_ID);
    for (const bad of [
      "",
      "v1",
      "v1..",
      token.slice(0, -1),
      token.slice(0, token.lastIndexOf(".")),
      `${token}.extra`,
      `${token}${token}`,
      `v2.${token.slice(3)}`,
      "a".repeat(513),
      `${token} `,
      "v1.%%%.%%%",
    ]) {
      expect(signer.verify(bad)).toBeNull();
    }
  });

  it("署名が正しくても、用途違い・sub が UUID でない・型違いの token は拒否する", () => {
    expect(signer.verify(forge(KEY, { purpose: "reminder-unsubscribe", sub: PUBLIC_ID }))).toBe(
      PUBLIC_ID,
    );
    for (const payload of [
      { purpose: "password-reset", sub: PUBLIC_ID },
      { purpose: "reminder-unsubscribe", sub: "42" },
      { purpose: "reminder-unsubscribe", sub: 42 },
      { purpose: "reminder-unsubscribe" },
      { sub: PUBLIC_ID },
      "string",
      null,
      [],
    ]) {
      expect(signer.verify(forge(KEY, payload))).toBeNull();
    }
  });

  it("署名が正しくても、長すぎる token(512 文字超)は拒否する(解析量の上限)", () => {
    const padded = forge(KEY, {
      purpose: "reminder-unsubscribe",
      sub: PUBLIC_ID,
      pad: "x".repeat(600),
    });
    expect(padded.length).toBeGreaterThan(512);
    expect(signer.verify(padded)).toBeNull();
    const small = forge(KEY, { purpose: "reminder-unsubscribe", sub: PUBLIC_ID, pad: "x" });
    expect(signer.verify(small)).toBe(PUBLIC_ID);
  });

  it("短すぎる署名鍵は拒否する", () => {
    expect(() => createHmacUnsubscribeTokenSigner("short")).toThrow();
  });
});
