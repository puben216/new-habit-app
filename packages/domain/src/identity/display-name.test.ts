import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX_LENGTH, parseDisplayName } from "./display-name";

/** 制御文字等はソース上に直接書かず code point で組み立てる(エディタ/ツールによる変換を避ける)。 */
function withCodePoint(codePoint: number): string {
  return `a${String.fromCodePoint(codePoint)}b`;
}

describe("parseDisplayName(PROF-003)", () => {
  it("1文字と50文字は許可する", () => {
    expect(parseDisplayName("あ")).toBe("あ");
    expect(parseDisplayName("a".repeat(DISPLAY_NAME_MAX_LENGTH))).toBe("a".repeat(50));
  });

  it("51文字は拒否する", () => {
    expect(parseDisplayName("a".repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBeNull();
  });

  it("空文字と空白のみは拒否する(全角空白を含む)", () => {
    expect(parseDisplayName("")).toBeNull();
    expect(parseDisplayName("   ")).toBeNull();
    expect(parseDisplayName(String.fromCodePoint(0x3000))).toBeNull();
  });

  it("前後の空白を除去して返す", () => {
    expect(parseDisplayName("  たなか  ")).toBe("たなか");
  });

  it("文字数はcode point単位で数える(サロゲートペアは1文字)", () => {
    expect(parseDisplayName("😀".repeat(50))).toBe("😀".repeat(50));
    expect(parseDisplayName("😀".repeat(51))).toBeNull();
  });

  it("NFC正規化した値を返す", () => {
    const decomposed = String.fromCodePoint(0x304b, 0x3099); // か + 結合濁点
    expect(parseDisplayName(decomposed)).toBe(String.fromCodePoint(0x304c));
  });

  it.each([
    ["NUL", 0x0000],
    ["改行", 0x000a],
    ["タブ", 0x0009],
    ["DEL", 0x007f],
    ["C1制御(NEL)", 0x0085],
    ["行区切り", 0x2028],
    ["段落区切り", 0x2029],
    ["RLO", 0x202e],
    ["LRI", 0x2066],
  ])("%s を含む場合は拒否する", (_label, codePoint) => {
    expect(parseDisplayName(withCodePoint(codePoint))).toBeNull();
  });

  it("文字列以外は拒否する", () => {
    expect(parseDisplayName(null)).toBeNull();
    expect(parseDisplayName(123)).toBeNull();
    expect(parseDisplayName(undefined)).toBeNull();
  });

  it("HTMLを含む文字列は保存対象としてそのまま許可する(出力時escapingはPresentationの責務)", () => {
    expect(parseDisplayName("<b>x</b>")).toBe("<b>x</b>");
  });
});
