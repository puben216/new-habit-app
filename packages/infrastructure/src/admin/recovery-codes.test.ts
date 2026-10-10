import { describe, expect, it } from "vitest";
import { RECOVERY_CODE_ALPHABET, parseMfaCode } from "@habit-app/domain";

import { generateRecoveryCode, generateRecoveryCodes, hashRecoveryCode } from "./recovery-codes";
import { createIpHasher } from "./ip-hasher";

describe("recovery codes", () => {
  it("正規形 XXXXX-XXXXX で、許可した文字集合のみ。Domain の parseMfaCode で解釈できる", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateRecoveryCode();
      expect(code).toMatch(
        new RegExp(`^[${RECOVERY_CODE_ALPHABET}]{5}-[${RECOVERY_CODE_ALPHABET}]{5}$`),
      );
      expect(parseMfaCode(code)).toEqual({ kind: "recovery", code });
    }
  });

  it("指定した個数の重複しないコードと、同じ順序のハッシュを返す。ハッシュは平文を含まない", () => {
    const { codes, hashes } = generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect(hashes).toEqual(codes.map(hashRecoveryCode));
    for (const [i, hash] of hashes.entries()) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain(codes[i]?.replace("-", "").toLowerCase() ?? "?");
    }
  });

  it("文字の出現に大きな偏りがない(32 文字の集合に一様)", () => {
    const counts = new Map<string, number>();
    const total = 3000;
    for (let i = 0; i < total; i += 1) {
      for (const char of generateRecoveryCode().replace("-", ""))
        counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    const expected = (total * 10) / 32;
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.8);
      expect(count).toBeLessThan(expected * 1.2);
    }
  });

  it("ハッシュは決定的で、別のコードは別のハッシュ", () => {
    expect(hashRecoveryCode("ABCDE-23456")).toBe(hashRecoveryCode("ABCDE-23456"));
    expect(hashRecoveryCode("ABCDE-23456")).not.toBe(hashRecoveryCode("ABCDE-23457"));
  });
});

describe("createIpHasher", () => {
  const key = "k".repeat(40);

  it("同じ IP は同じハッシュ、別の IP・別の鍵は別のハッシュ。生の IP を含まない", () => {
    const hash = createIpHasher(key);
    expect(hash("203.0.113.7")).toBe(hash("203.0.113.7"));
    expect(hash("203.0.113.7")).not.toBe(hash("203.0.113.8"));
    expect(createIpHasher("j".repeat(40))("203.0.113.7")).not.toBe(hash("203.0.113.7"));
    expect(hash("203.0.113.7")).toMatch(/^[0-9a-f]{64}$/);
    expect(hash("203.0.113.7")).not.toContain("203");
  });

  it("IP が取得できない場合は固定値のハッシュ。短すぎる鍵は拒否する", () => {
    const hash = createIpHasher(key);
    expect(hash(null)).toBe(hash(null));
    expect(hash(null)).not.toBe(hash("unknown-ip"));
    expect(() => createIpHasher("short")).toThrow("32 bytes");
  });
});
