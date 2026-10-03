import { describe, expect, it } from "vitest";
import { InvalidProfileError } from "./errors";
import { createDefaultProfile, validateProfileChanges } from "./profile";

describe("createDefaultProfile(PROF-006)", () => {
  it("暫定既定値を返す", () => {
    expect(createDefaultProfile()).toEqual({
      displayName: null,
      timezone: "Asia/Tokyo",
      locale: "ja",
      weekStartsOn: 1,
    });
  });
});

describe("validateProfileChanges(PROF-002)", () => {
  it("指定された項目のみを正規化して返す", () => {
    expect(validateProfileChanges({ displayName: " たなか ", timezone: "Asia/Tokyo" })).toEqual({
      displayName: "たなか",
      timezone: "Asia/Tokyo",
    });
  });

  it("undefinedの項目は無視する", () => {
    expect(validateProfileChanges({ locale: "en", weekStartsOn: undefined })).toEqual({
      locale: "en",
    });
  });

  it("weekStartsOnの0(日曜)も有効な変更として扱う", () => {
    expect(validateProfileChanges({ weekStartsOn: 0 })).toEqual({ weekStartsOn: 0 });
  });

  it("複数の違反をすべて集約し、入力値をメッセージへ含めない", () => {
    try {
      validateProfileChanges({ displayName: "", timezone: "JST", locale: "fr", weekStartsOn: 9 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProfileError);
      const violations = (error as InvalidProfileError).violations;
      expect(violations.map((v) => v.field)).toEqual([
        "displayName",
        "timezone",
        "locale",
        "weekStartsOn",
      ]);
      for (const violation of violations) {
        expect(violation.message).not.toContain("JST");
        expect(violation.message).not.toContain("fr");
      }
    }
  });

  it("nullは拒否する(項目の削除は許可しない)", () => {
    expect(() => validateProfileChanges({ displayName: null })).toThrow(InvalidProfileError);
  });

  it("空の更新は_rootの違反として拒否する", () => {
    try {
      validateProfileChanges({});
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidProfileError).violations).toEqual([
        { field: "_root", message: expect.any(String) },
      ]);
    }
  });
});
