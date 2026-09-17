import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("前後の空白を除去する", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  it("local part・domain partをともに小文字化する", () => {
    expect(normalizeEmail("User.Name@Example.COM")).toBe("user.name@example.com");
  });

  it("Unicode正規化(NFC)を行う", () => {
    const combiningAcute = String.fromCharCode(0x0301);
    const eWithCombiningAcute = "e" + combiningAcute;
    const eAcute = String.fromCharCode(0x00e9);
    const nfd = "user@caf" + eWithCombiningAcute + ".example";
    const nfc = "user@caf" + eAcute + ".example";

    expect(nfd).not.toBe(nfc);
    expect(normalizeEmail(nfd)).toBe(nfc);
  });

  it("Gmail固有のdot除去・plusタグ除去は行わない", () => {
    expect(normalizeEmail("user.name+tag@gmail.com")).toBe("user.name+tag@gmail.com");
  });
});
