import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { displayNameIssueMessage, mapProfileFieldErrors } from "./messages";
import { buildTimezoneOptions, pickInitialTimezone } from "./timezone-options";
import { DISPLAY_NAME_MAX_LENGTH, validateDisplayName } from "./validation";

describe("buildTimezoneOptions", () => {
  it("UTC と現在値を含め、重複なしでソートする", () => {
    const result = buildTimezoneOptions(
      ["Asia/Tokyo", "America/New_York", "Asia/Tokyo"],
      "Asia/Kolkata",
    );
    expect(result).toEqual(["America/New_York", "Asia/Kolkata", "Asia/Tokyo", "UTC"]);
  });

  it("性質: 任意の入力で現在値と UTC を含み、重複がなく、昇順", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string({ minLength: 1 }), (supported, current) => {
        const result = buildTimezoneOptions(supported, current);
        expect(result).toContain(current);
        expect(result).toContain("UTC");
        expect(new Set(result).size).toBe(result.length);
        expect([...result].sort((a, b) => a.localeCompare(b, "en"))).toEqual(result);
      }),
    );
  });
});

describe("pickInitialTimezone", () => {
  const options = ["Asia/Tokyo", "UTC"];
  it("検出値が選択肢にあればそれ、なければ現在値", () => {
    expect(pickInitialTimezone("UTC", options, "Asia/Tokyo")).toBe("UTC");
    expect(pickInitialTimezone("Mars/Base", options, "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(pickInitialTimezone(undefined, options, "Asia/Tokyo")).toBe("Asia/Tokyo");
  });
});

describe("validateDisplayName", () => {
  it("空・空白のみは required", () => {
    expect(validateDisplayName("")).toBe("required");
    expect(validateDisplayName("  　 ")).toBe("required");
  });

  it("上限は code point で 50(絵文字は 1 文字)", () => {
    expect(validateDisplayName("あ".repeat(DISPLAY_NAME_MAX_LENGTH))).toBeNull();
    expect(validateDisplayName("あ".repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBe("too_long");
    expect(validateDisplayName("😀".repeat(DISPLAY_NAME_MAX_LENGTH))).toBeNull();
    expect(validateDisplayName("😀".repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBe("too_long");
  });

  it("前後の空白は数えない", () => {
    expect(validateDisplayName(` ${"a".repeat(DISPLAY_NAME_MAX_LENGTH)} `)).toBeNull();
  });

  it("性質: 空白のみでない 1〜50 code point は通る", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", minLength: 1, maxLength: 20 }).filter((v) => v.trim() !== ""),
        (value) => {
          expect(validateDisplayName(value)).toBeNull();
        },
      ),
    );
  });
});

describe("messages", () => {
  it("fieldErrors はキーだけを使い server の文字列を出さない", () => {
    const result = mapProfileFieldErrors({ timezone: ["SECRET detail"] });
    expect(result.fields.timezone).toBe("タイムゾーンを選び直してください。");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result.form).toBeNull();
  });

  it("未知のキーのみならフォーム全体の固定文言", () => {
    expect(mapProfileFieldErrors({ _root: ["x"] }).form).toBe("入力内容を確認してください。");
    expect(mapProfileFieldErrors(undefined).form).toBe("入力内容を確認してください。");
  });

  it("表示名の issue ごとに文言が異なる", () => {
    expect(displayNameIssueMessage("required")).not.toBe(displayNameIssueMessage("too_long"));
  });
});
