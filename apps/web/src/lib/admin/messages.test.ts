import { describe, expect, it } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/lib/api/api-error";

import {
  MFA_INVALID_MESSAGE,
  MFA_LOCKED_MESSAGE,
  NETWORK_MESSAGE,
  UNEXPECTED_MESSAGE,
  classifyAdminError,
  mfaErrorMessage,
} from "./messages";

const error = (status: number, code: string) => new ApiError({ status, code });

describe("classifyAdminError", () => {
  it.each([
    [error(403, "invalid_mfa_code"), "mfa_invalid"],
    [error(429, "mfa_locked"), "mfa_locked"],
    [error(403, "mfa_required"), "mfa_required"],
    [error(404, "not_found"), "not_found"],
    [error(404, "user_not_found"), "not_found"],
    [error(422, "validation_failed"), "invalid_input"],
    [error(500, "internal"), "unexpected"],
    [error(403, "invalid_origin"), "unexpected"],
    [error(0, CLIENT_ERROR_CODES.networkError), "network"],
    [error(0, CLIENT_ERROR_CODES.invalidRequestPath), "not_found"],
    [error(200, CLIENT_ERROR_CODES.invalidResponse), "unexpected"],
    [new Error("boom"), "unexpected"],
    ["x", "unexpected"],
  ] as const)("%# を分類する", (input, expected) => {
    expect(classifyAdminError(input)).toBe(expected);
  });

  it("status と code の組が合わなければ MFA の失敗として扱わない", () => {
    expect(classifyAdminError(error(429, "invalid_mfa_code"))).toBe("unexpected");
    expect(classifyAdminError(error(403, "mfa_locked"))).toBe("unexpected");
  });
});

describe("mfaErrorMessage", () => {
  it("固定の文言を返す。TOTP とリカバリーコードのどちらが誤りかは示さない", () => {
    expect(mfaErrorMessage("mfa_invalid")).toBe(MFA_INVALID_MESSAGE);
    expect(mfaErrorMessage("mfa_locked")).toBe(MFA_LOCKED_MESSAGE);
    expect(mfaErrorMessage("network")).toBe(NETWORK_MESSAGE);
    expect(mfaErrorMessage("unexpected")).toBe(UNEXPECTED_MESSAGE);
    expect(MFA_INVALID_MESSAGE).not.toMatch(/リカバリー|TOTP|6 桁/);
  });
});
