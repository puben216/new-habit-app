import { describe, expect, it } from "vitest";

import {
  adminAiJobFailuresQuerySchema,
  adminMfaVerifyRequestSchema,
  adminNotificationFailuresQuerySchema,
  adminNotificationFailuresResponseSchema,
  adminUserOverviewResponseSchema,
  adminUserPublicIdSchema,
  adminUserSearchQuerySchema,
} from "./admin";

describe("adminMfaVerifyRequestSchema", () => {
  it("code(文字列)だけ受理する。未知キー・型違い・長すぎる値は拒否", () => {
    expect(adminMfaVerifyRequestSchema.safeParse({ code: "123456" }).success).toBe(true);
    // 形式の誤りはここでは弾かない(形式を oracle にしない。Domain が無効なコードとして扱う)。
    expect(adminMfaVerifyRequestSchema.safeParse({ code: "abc" }).success).toBe(true);
    expect(adminMfaVerifyRequestSchema.safeParse({ code: 123456 }).success).toBe(false);
    expect(adminMfaVerifyRequestSchema.safeParse({ code: "1".repeat(65) }).success).toBe(false);
    expect(adminMfaVerifyRequestSchema.safeParse({ code: "123456", userId: "1" }).success).toBe(
      false,
    );
    expect(adminMfaVerifyRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("adminUserSearchQuerySchema", () => {
  it("email 形式のみ受理(前後の空白は除去)し、空・形式不正・254 文字超は拒否", () => {
    expect(adminUserSearchQuerySchema.parse({ email: "  user@example.test " }).email).toBe(
      "user@example.test",
    );
    for (const bad of ["", "   ", "user", "@example.test", `${"a".repeat(250)}@example.test`]) {
      expect(adminUserSearchQuerySchema.safeParse({ email: bad }).success).toBe(false);
    }
    expect(adminUserSearchQuerySchema.safeParse({ email: "a@example.test", x: 1 }).success).toBe(
      false,
    );
  });
});

describe("一覧の query", () => {
  it("status は許可した値のみ、limit は 1〜50 の整数(文字列から変換)、cursor は十進文字列", () => {
    expect(adminNotificationFailuresQuerySchema.parse({})).toEqual({});
    expect(
      adminNotificationFailuresQuerySchema.parse({ status: "expired", limit: "50", cursor: "42" }),
    ).toEqual({ status: "expired", limit: 50, cursor: "42" });
    for (const bad of [
      { status: "sent" },
      { limit: "0" },
      { limit: "51" },
      { limit: "1.5" },
      { limit: "abc" },
      { cursor: "0" },
      { cursor: "-1" },
      { cursor: "abc" },
      { cursor: "1".repeat(20) },
      { extra: "x" },
    ]) {
      expect(adminNotificationFailuresQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("AI ジョブは failed/fallback のみ", () => {
    expect(adminAiJobFailuresQuerySchema.safeParse({ status: "fallback" }).success).toBe(true);
    expect(adminAiJobFailuresQuerySchema.safeParse({ status: "expired" }).success).toBe(false);
  });
});

describe("公開 ID と応答の allowlist", () => {
  it("公開 ID は UUID のみ", () => {
    expect(adminUserPublicIdSchema.safeParse("3f2b8c1e-5a47-4d9e-8c36-1b2a9e7d4f10").success).toBe(
      true,
    );
    expect(adminUserPublicIdSchema.safeParse("42").success).toBe(false);
    expect(adminUserPublicIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("応答 schema は余計な項目(email など)を落とす", () => {
    const parsed = adminNotificationFailuresResponseSchema.parse({
      items: [
        {
          id: "1",
          userPublicId: "3f2b8c1e-5a47-4d9e-8c36-1b2a9e7d4f10",
          status: "failed",
          failureCode: null,
          attemptCount: 1,
          scheduledAt: "2026-10-10T00:00:00.000Z",
          localDate: "2026-10-10",
          updatedAt: "2026-10-10T00:00:00.000Z",
          email: "leak@example.test",
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(parsed)).not.toContain("leak@example.test");
    expect(
      adminUserOverviewResponseSchema.safeParse({
        publicId: "3f2b8c1e-5a47-4d9e-8c36-1b2a9e7d4f10",
        emailMasked: "u***@example.test",
        status: "active",
        createdAt: "2026-10-10T00:00:00.000Z",
        emailVerified: true,
        notification: { suppressed: false, deliveries: { failed: 1 } },
        aiJobs: {},
      }).success,
    ).toBe(true);
  });
});
