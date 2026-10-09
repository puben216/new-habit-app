import { describe, expect, it } from "vitest";

import {
  FORM_INVALID_MESSAGE,
  LOGIN_FAILED_MESSAGE,
  issueMessage,
  mapFieldErrors,
  serverRejectedMessage,
} from "./messages";

describe("mapFieldErrors", () => {
  it("キーだけを使い、server の文字列を文言に含めない", () => {
    const result = mapFieldErrors(
      { password: ["SECRET: password found in breach list"], email: ["internal detail"] },
      ["email", "password"],
    );

    expect(result.fields.email).toBe(serverRejectedMessage("email"));
    expect(result.fields.password).toBe(serverRejectedMessage("password"));
    expect(result.form).toBeNull();
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("internal detail");
  });

  it("未知のキーだけ、または fieldErrors なしはフォーム全体の固定文言", () => {
    expect(mapFieldErrors({ unknown: ["x"] }, ["email", "password"])).toEqual({
      fields: {},
      form: FORM_INVALID_MESSAGE,
    });
    expect(mapFieldErrors(undefined, ["email"])).toEqual({
      fields: {},
      form: FORM_INVALID_MESSAGE,
    });
  });

  it("このフォームに無い項目のキーは無視する(allowed のみ)", () => {
    const result = mapFieldErrors({ password: ["x"] }, ["email"]);
    expect(result.fields).toEqual({});
    expect(result.form).toBe(FORM_INVALID_MESSAGE);
  });
});

describe("issueMessage", () => {
  it("項目名と種類から固定文言を作る", () => {
    expect(issueMessage("email", "required")).toBe("メールアドレスを入力してください。");
    expect(issueMessage("password", "too_long")).toBe(
      "パスワードは128文字以内で入力してください。",
    );
    expect(issueMessage("email", "format")).toBe("メールアドレスの形式を確認してください。");
  });
});

describe("LOGIN_FAILED_MESSAGE", () => {
  it("アカウントの状態(存在・確認済み)を示す語を含まない", () => {
    expect(LOGIN_FAILED_MESSAGE).not.toMatch(/存在しません|登録されていません|ロック/);
  });
});
