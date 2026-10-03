import { describe, expect, it } from "vitest";
import { profileResponseSchema, updateProfileRequestSchema } from "./profile";

describe("updateProfileRequestSchema", () => {
  it("1項目以上の部分更新を受け付ける", () => {
    expect(updateProfileRequestSchema.safeParse({ displayName: "たなか" }).success).toBe(true);
    expect(updateProfileRequestSchema.safeParse({ weekStartsOn: 0 }).success).toBe(true);
    expect(
      updateProfileRequestSchema.safeParse({
        displayName: "a",
        timezone: "Asia/Tokyo",
        locale: "ja",
        weekStartsOn: 1,
      }).success,
    ).toBe(true);
  });

  it("空のbodyを拒否する", () => {
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false);
  });

  it("未知キーを拒否する(mass assignment防止)", () => {
    expect(
      updateProfileRequestSchema.safeParse({ displayName: "a", status: "active" }).success,
    ).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ email: "a@example.com" }).success).toBe(false);
  });

  it("型違い・nullを拒否する", () => {
    expect(updateProfileRequestSchema.safeParse({ displayName: null }).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ weekStartsOn: "1" }).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ weekStartsOn: 1.5 }).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ timezone: 9 }).success).toBe(false);
  });

  it("入力上限を超える文字列を拒否する", () => {
    expect(updateProfileRequestSchema.safeParse({ displayName: "a".repeat(201) }).success).toBe(
      false,
    );
    expect(updateProfileRequestSchema.safeParse({ timezone: "a".repeat(65) }).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ locale: "a".repeat(17) }).success).toBe(false);
  });

  it("配列やnullなどオブジェクト以外を拒否する", () => {
    expect(updateProfileRequestSchema.safeParse([]).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse(null).success).toBe(false);
  });
});

describe("profileResponseSchema", () => {
  it("displayNameがnullのレスポンスを許可する", () => {
    expect(
      profileResponseSchema.safeParse({
        displayName: null,
        timezone: "Asia/Tokyo",
        locale: "ja",
        weekStartsOn: 1,
        updatedAt: "2026-10-02T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
