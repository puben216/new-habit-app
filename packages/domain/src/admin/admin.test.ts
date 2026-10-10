import { describe, expect, it } from "vitest";

import {
  ADMIN_MFA_TTL_MS,
  isMfaFresh,
  isMfaLocked,
  mfaExpiresAt,
  mfaRetryAfterSeconds,
} from "./policy";
import { maskEmail } from "./mask-email";
import { RECOVERY_CODE_ALPHABET, parseMfaCode } from "./mfa-code";

const NOW = new Date("2026-10-10T03:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const minutes = (n: number) => n * 60_000;

describe("isMfaFresh", () => {
  it("未検証は無効、29 分は有効、30 分ちょうどは無効、31 分は無効", () => {
    expect(ADMIN_MFA_TTL_MS).toBe(minutes(30));
    expect(isMfaFresh(null, NOW)).toBe(false);
    expect(isMfaFresh(ago(0), NOW)).toBe(true);
    expect(isMfaFresh(ago(minutes(29)), NOW)).toBe(true);
    expect(isMfaFresh(ago(ADMIN_MFA_TTL_MS - 1), NOW)).toBe(true);
    expect(isMfaFresh(ago(ADMIN_MFA_TTL_MS), NOW)).toBe(false);
    expect(isMfaFresh(ago(minutes(31)), NOW)).toBe(false);
  });

  it("未来の検証時刻(時計のずれ・改ざん)は無効", () => {
    expect(isMfaFresh(new Date(NOW.getTime() + 1), NOW)).toBe(false);
    expect(isMfaFresh(new Date(NOW.getTime() + minutes(5)), NOW)).toBe(false);
  });

  it("有効期限は検証時刻 + 30 分。無効なら null", () => {
    const verified = ago(minutes(10));
    expect(mfaExpiresAt(verified, NOW)?.toISOString()).toBe(
      new Date(verified.getTime() + ADMIN_MFA_TTL_MS).toISOString(),
    );
    expect(mfaExpiresAt(null, NOW)).toBeNull();
    expect(mfaExpiresAt(ago(minutes(30)), NOW)).toBeNull();
  });
});

describe("ロック", () => {
  it("lockedUntil が未来ならロック中、ちょうど・過去・null ならロックなし", () => {
    expect(isMfaLocked(null, NOW)).toBe(false);
    expect(isMfaLocked(new Date(NOW.getTime() + 1), NOW)).toBe(true);
    expect(isMfaLocked(NOW, NOW)).toBe(false);
    expect(isMfaLocked(ago(1), NOW)).toBe(false);
  });

  it("残り秒数は切り上げ、ロックなしなら 0", () => {
    expect(mfaRetryAfterSeconds(new Date(NOW.getTime() + 1), NOW)).toBe(1);
    expect(mfaRetryAfterSeconds(new Date(NOW.getTime() + 1500), NOW)).toBe(2);
    expect(mfaRetryAfterSeconds(new Date(NOW.getTime() + minutes(15)), NOW)).toBe(900);
    expect(mfaRetryAfterSeconds(null, NOW)).toBe(0);
    expect(mfaRetryAfterSeconds(ago(1000), NOW)).toBe(0);
  });
});

describe("maskEmail", () => {
  it("先頭 1 文字 + *** + ドメイン", () => {
    expect(maskEmail("user@example.test")).toBe("u***@example.test");
    expect(maskEmail("ab@example.test")).toBe("a***@example.test");
  });

  it("ローカル部が 1 文字なら文字そのものを出さない。@ がなければ全体をマスク", () => {
    expect(maskEmail("a@example.test")).toBe("***@example.test");
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });

  it("サロゲートペアの先頭を壊さない", () => {
    expect(maskEmail("😀user@example.test")).toBe("😀***@example.test");
  });

  it("任意のローカル部でマスク結果に 2 文字目以降が現れない(プロパティ)", () => {
    let state = 403;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789._+-";
    for (let i = 0; i < 500; i += 1) {
      const length = 2 + Math.floor(random() * 20);
      const local = Array.from({ length }, () => chars[Math.floor(random() * chars.length)]).join(
        "",
      );
      const masked = maskEmail(`${local}@example.test`);
      const [maskedLocal] = masked.split("@");
      expect(maskedLocal).toBe(`${local[0]}***`);
      expect(masked.endsWith("@example.test")).toBe(true);
      // マスクの長さがローカル部の長さに依存しない(長さも漏らさない)。
      expect(maskedLocal?.length).toBe(4);
    }
  });
});

describe("parseMfaCode", () => {
  it("6 桁の数字は TOTP(空白を無視)", () => {
    expect(parseMfaCode("123456")).toEqual({ kind: "totp", code: "123456" });
    expect(parseMfaCode(" 123 456 ")).toEqual({ kind: "totp", code: "123456" });
    expect(parseMfaCode("000000")).toEqual({ kind: "totp", code: "000000" });
  });

  it("TOTP の桁数違い・文字混入は null", () => {
    for (const bad of ["12345", "1234567", "12345a", "12-3456x", "", "      "]) {
      expect(parseMfaCode(bad)).toBeNull();
    }
  });

  it("リカバリーコードは大文字小文字・空白・ハイフンの有無を無視して正規形 XXXXX-XXXXX にする", () => {
    expect(parseMfaCode("abcde-23456")).toEqual({ kind: "recovery", code: "ABCDE-23456" });
    expect(parseMfaCode("  ABCDE 23456 ")).toEqual({ kind: "recovery", code: "ABCDE-23456" });
    expect(parseMfaCode("abcde23456")).toEqual({ kind: "recovery", code: "ABCDE-23456" });
  });

  it("紛らわしい文字(0 O 1 I)・桁数違い・文字集合外は null", () => {
    for (const bad of [
      "ABCDE-0OI1A",
      "ABCD-23456",
      "ABCDE-234567",
      "ABCDE-2345!",
      "ABCDE--23456x",
    ]) {
      expect(parseMfaCode(bad)).toBeNull();
    }
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32);
    expect(RECOVERY_CODE_ALPHABET).not.toMatch(/[01OI]/);
  });

  it("文字列以外・長すぎる入力は null", () => {
    for (const bad of [123456, null, undefined, {}, [], "1".repeat(65)]) {
      expect(parseMfaCode(bad)).toBeNull();
    }
  });
});
