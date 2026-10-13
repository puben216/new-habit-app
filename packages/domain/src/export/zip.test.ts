import { describe, expect, it } from "vitest";

import { buildStoredZip, crc32 } from "./zip";
import { encodeUtf8 } from "./utf8";

describe("crc32", () => {
  it("既知のベクトル(標準の検査値)", () => {
    expect(crc32(encodeUtf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(encodeUtf8("a"))).toBe(0xe8b7be43);
    expect(crc32(encodeUtf8("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("encodeUtf8", () => {
  it("ASCII・日本語・絵文字・対になっていないサロゲートを UTF-8 にする", () => {
    expect([...encodeUtf8("A")]).toEqual([0x41]);
    expect([...encodeUtf8("é")]).toEqual([0xc3, 0xa9]);
    expect([...encodeUtf8("あ")]).toEqual([0xe3, 0x81, 0x82]);
    expect([...encodeUtf8("😀")]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect([...encodeUtf8("\ud800")]).toEqual([0xef, 0xbf, 0xbd]);
    expect([...encodeUtf8("\udc00a")]).toEqual([0xef, 0xbf, 0xbd, 0x61]);
    expect(encodeUtf8("").length).toBe(0);
  });
});

describe("buildStoredZip の入力検証", () => {
  const data = encodeUtf8("x");
  const at = new Date("2026-10-13T03:00:00.000Z");

  it("ディレクトリ・パス・不正な文字・空・長すぎる名前、重複を拒否する", () => {
    for (const name of ["", "a/b.csv", "../x", "a b.csv", "あ.csv", "a\\b", "x".repeat(101)]) {
      expect(() => buildStoredZip([{ name, data }], at), name).toThrow("invalid zip entry name");
    }
    expect(() =>
      buildStoredZip(
        [
          { name: "a.csv", data },
          { name: "a.csv", data },
        ],
        at,
      ),
    ).toThrow("invalid zip entry name");
  });

  it("空の ZIP も作れる(終端レコードのみ)", () => {
    expect(buildStoredZip([], at).length).toBe(22);
  });
});
