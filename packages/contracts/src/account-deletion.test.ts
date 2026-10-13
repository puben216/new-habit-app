import { describe, expect, it } from "vitest";

import {
  REAUTH_PASSWORD_MAX_LENGTH,
  accountDeletionRequestedResponseSchema,
  accountDeletionStatusResponseSchema,
  requestAccountDeletionRequestSchema,
} from "./account-deletion";

const parse = (body: unknown) => requestAccountDeletionRequestSchema.safeParse(body);

describe("requestAccountDeletionRequestSchema", () => {
  it("password だけを受け付ける。前後の空白もパスワードの一部として変更しない", () => {
    expect(parse({ password: "correct horse" })).toMatchObject({
      success: true,
      data: { password: "correct horse" },
    });
    expect(parse({ password: "  spaced  " })).toMatchObject({
      success: true,
      data: { password: "  spaced  " },
    });
  });

  it("空・文字列以外・上限超過・欠落を拒否する。上限ちょうどは受理する", () => {
    expect(parse({ password: "" }).success).toBe(false);
    expect(parse({ password: 12345678 }).success).toBe(false);
    expect(parse({ password: null }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    expect(parse({ password: "a".repeat(REAUTH_PASSWORD_MAX_LENGTH) }).success).toBe(true);
    expect(parse({ password: "a".repeat(REAUTH_PASSWORD_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it.each(["userId", "email", "confirm", "reason"])("未知キー %s を拒否する", (key) => {
    expect(parse({ password: "x", [key]: "y" }).success).toBe(false);
  });
});

describe("response schemas", () => {
  it("要求の応答は deletion_pending と ISO 日時", () => {
    expect(
      accountDeletionRequestedResponseSchema.safeParse({
        status: "deletion_pending",
        scheduledFor: "2026-11-11T03:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      accountDeletionRequestedResponseSchema.safeParse({ status: "active", scheduledFor: "x" })
        .success,
    ).toBe(false);
  });

  it("状態の応答は active のとき scheduledFor が null", () => {
    expect(
      accountDeletionStatusResponseSchema.safeParse({ status: "active", scheduledFor: null })
        .success,
    ).toBe(true);
    expect(
      accountDeletionStatusResponseSchema.safeParse({ status: "suspended", scheduledFor: null })
        .success,
    ).toBe(false);
  });
});
