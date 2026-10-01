import { describe, expect, it } from "vitest";
import {
  passwordResetConfirmRequestSchema,
  passwordResetRequestSchema,
  resendVerificationRequestSchema,
  signUpRequestSchema,
  toFieldErrors,
  verifyEmailRequestSchema,
} from "./auth";

describe("signUpRequestSchema", () => {
  it("有効なemail/passwordを受け付ける", () => {
    const result = signUpRequestSchema.safeParse({
      email: "user@example.com",
      password: "a".repeat(10),
    });
    expect(result.success).toBe(true);
  });

  it("email形式が不正な場合は拒否する(AUTH-001)", () => {
    const result = signUpRequestSchema.safeParse({ email: "not-an-email", password: "password1" });
    expect(result.success).toBe(false);
  });

  it("未知キーを拒否する(共通仕様)", () => {
    const result = signUpRequestSchema.safeParse({
      email: "user@example.com",
      password: "password1",
      admin: true,
    });
    expect(result.success).toBe(false);
  });

  it("emailの上限(254文字)を超える場合は拒否する", () => {
    const longLocalPart = "a".repeat(250);
    const result = signUpRequestSchema.safeParse({
      email: `${longLocalPart}@example.com`,
      password: "password1",
    });
    expect(result.success).toBe(false);
  });

  it("passwordの上限(128文字)を超える場合は拒否する", () => {
    const result = signUpRequestSchema.safeParse({
      email: "user@example.com",
      password: "a".repeat(129),
    });
    expect(result.success).toBe(false);
  });
});

describe("resendVerificationRequestSchema / passwordResetRequestSchema", () => {
  it("email形式チェックを行わない(AUTH-INV-002、形式不正でもschema上は通す)", () => {
    expect(resendVerificationRequestSchema.safeParse({ email: "not-an-email" }).success).toBe(true);
    expect(passwordResetRequestSchema.safeParse({ email: "not-an-email" }).success).toBe(true);
  });

  it("未知キーを拒否する", () => {
    expect(
      resendVerificationRequestSchema.safeParse({ email: "user@example.com", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("verifyEmailRequestSchema / passwordResetConfirmRequestSchema", () => {
  it("tokenの上限(512文字)を超える場合は拒否する", () => {
    expect(verifyEmailRequestSchema.safeParse({ token: "a".repeat(513) }).success).toBe(false);
  });

  it("passwordResetConfirmはtoken/newPasswordを要求する", () => {
    const result = passwordResetConfirmRequestSchema.safeParse({
      token: "token-value",
      newPassword: "password1",
    });
    expect(result.success).toBe(true);
  });
});

describe("toFieldErrors", () => {
  it("zodのissueをフィールド単位でグルーピングする", () => {
    const result = signUpRequestSchema.safeParse({ email: "bad", password: "a".repeat(129) });
    if (result.success) throw new Error("expected failure");

    const fieldErrors = toFieldErrors(result.error.issues);
    expect(Object.keys(fieldErrors).sort()).toEqual(["email", "password"]);
    expect(fieldErrors["email"]?.length).toBeGreaterThan(0);
    expect(fieldErrors["password"]?.length).toBeGreaterThan(0);
  });
});
