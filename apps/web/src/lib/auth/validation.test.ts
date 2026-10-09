import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  TOKEN_MAX_LENGTH,
  validateEmail,
  validatePassword,
  validateToken,
} from "./validation";

describe("validateEmail", () => {
  it("未入力・空白のみは required", () => {
    expect(validateEmail("")).toBe("required");
    expect(validateEmail("   ")).toBe("required");
  });

  it("@ がない、または前後が空は format", () => {
    expect(validateEmail("plain")).toBe("format");
    expect(validateEmail("@example.test")).toBe("format");
    expect(validateEmail("a@")).toBe("format");
    expect(validateEmail("a b@example.test")).toBe("format");
    expect(validateEmail("a@b@c")).toBe("format");
  });

  it("上限(254 文字)の境界", () => {
    const local = "a".repeat(EMAIL_MAX_LENGTH - "@x.test".length);
    expect(validateEmail(`${local}@x.test`)).toBeNull();
    expect(validateEmail(`${local}a@x.test`)).toBe("too_long");
  });

  it("前後の空白は無視して判定する", () => {
    expect(validateEmail("  user@example.test  ")).toBeNull();
  });

  it("性質: 例外を投げず、結果は定義された値のいずれか", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (value) => {
        expect([null, "required", "too_long", "format"]).toContain(validateEmail(value));
      }),
    );
  });
});

describe("validatePassword", () => {
  it("空・空白のみは required", () => {
    expect(validatePassword("")).toBe("required");
    expect(validatePassword("     ")).toBe("required");
  });

  it("最小文字数は server の判定に任せる(短くても client は通す)", () => {
    expect(validatePassword("a")).toBeNull();
  });

  it("先頭・末尾の空白も値の一部として上限判定に含める", () => {
    expect(validatePassword(" ".repeat(2) + "a".repeat(PASSWORD_MAX_LENGTH - 2))).toBeNull();
    expect(validatePassword(" ".repeat(3) + "a".repeat(PASSWORD_MAX_LENGTH - 2))).toBe("too_long");
  });

  it("上限(128 文字)の境界", () => {
    expect(validatePassword("a".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(validatePassword("a".repeat(PASSWORD_MAX_LENGTH + 1))).toBe("too_long");
  });

  it("性質: 空白のみでない 1〜128 文字は必ず通る", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH })
          .filter((v) => v.trim().length > 0),
        (value) => {
          expect(validatePassword(value)).toBeNull();
        },
      ),
    );
  });
});

describe("validateToken", () => {
  it("空は required、512 文字が上限", () => {
    expect(validateToken("")).toBe("required");
    expect(validateToken("t".repeat(TOKEN_MAX_LENGTH))).toBeNull();
    expect(validateToken("t".repeat(TOKEN_MAX_LENGTH + 1))).toBe("too_long");
  });
});
