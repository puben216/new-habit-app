import { describe, expect, it } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/lib/api/api-error";

import { describeFormError, isInvalidTokenError } from "./form-errors";
import {
  FORM_INVALID_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  serverRejectedMessage,
} from "./messages";

describe("describeFormError", () => {
  it("network_error は通信失敗の固定文言", () => {
    const error = new ApiError({ status: 0, code: CLIENT_ERROR_CODES.networkError });
    expect(describeFormError(error, ["email"])).toEqual({
      fields: {},
      form: NETWORK_ERROR_MESSAGE,
    });
  });

  it("422 は fieldErrors のキーに対応する項目の固定文言", () => {
    const error = new ApiError({
      status: 422,
      code: "validation_failed",
      fieldErrors: { password: ["internal"] },
    });
    expect(describeFormError(error, ["email", "password"])).toEqual({
      fields: { password: serverRejectedMessage("password") },
      form: null,
    });
  });

  it("422 でも対応する項目がなければフォーム全体の固定文言", () => {
    const error = new ApiError({ status: 422, code: "invalid_request_body" });
    expect(describeFormError(error, ["email"]).form).toBe(FORM_INVALID_MESSAGE);
  });

  it("それ以外の ApiError と ApiError 以外は想定外の固定文言", () => {
    expect(describeFormError(new ApiError({ status: 500, code: "x" }), []).form).toBe(
      UNEXPECTED_ERROR_MESSAGE,
    );
    expect(describeFormError(new Error("SECRET"), []).form).toBe(UNEXPECTED_ERROR_MESSAGE);
  });
});

describe("isInvalidTokenError", () => {
  it("400 かつ invalid_or_expired_token のみ true", () => {
    expect(
      isInvalidTokenError(new ApiError({ status: 400, code: "invalid_or_expired_token" })),
    ).toBe(true);
    expect(isInvalidTokenError(new ApiError({ status: 400, code: "other" }))).toBe(false);
    expect(
      isInvalidTokenError(new ApiError({ status: 422, code: "invalid_or_expired_token" })),
    ).toBe(false);
    expect(isInvalidTokenError(new Error("x"))).toBe(false);
  });
});
