import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { neutralizeFormula, toCsv, toCsvCell } from "./csv";

/** テスト用の最小の CSV パーサ(RFC 4180。引用符・改行・カンマに対応)。実装とは独立に書く。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text.charAt(i + 1) === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += ch;
  }
  return rows;
}

describe("neutralizeFormula(EXP-006: CSV インジェクション対策)", () => {
  it.each(["=SUM(1,1)", "+1", "-1", "@cmd", "\tx", "\rx"])("%j は先頭に ' を付ける", (value) => {
    expect(neutralizeFormula(value)).toBe(`'${value}`);
  });

  it.each(["", "abc", "1=1", "あ=い", " =x", "'=x", "x\t", "2026-10-13"])(
    "%j はそのまま",
    (value) => {
      expect(neutralizeFormula(value)).toBe(value);
    },
  );
});

describe("toCsvCell", () => {
  it("null/undefined は空、数値・真偽値は文字列化のみ(負数は数式対策の対象外)", () => {
    expect(toCsvCell(null)).toBe("");
    expect(toCsvCell(undefined)).toBe("");
    expect(toCsvCell(5)).toBe("5");
    expect(toCsvCell(-5)).toBe("-5");
    expect(toCsvCell(0)).toBe("0");
    expect(toCsvCell(true)).toBe("true");
    expect(toCsvCell(false)).toBe("false");
    expect(toCsvCell(Number.NaN)).toBe("");
    expect(toCsvCell(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("文字列のカンマ・引用符・改行は引用符で囲み、引用符は二重にする", () => {
    expect(toCsvCell("a,b")).toBe('"a,b"');
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(toCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(toCsvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(toCsvCell("plain")).toBe("plain");
    expect(toCsvCell("日本語🙂")).toBe("日本語🙂");
  });

  it("数式の先頭文字は無害化し、必要なら引用もする", () => {
    expect(toCsvCell("=SUM(1,1)")).toBe(`"'=SUM(1,1)"`);
    expect(toCsvCell("-5")).toBe("'-5"); // 文字列の "-5" は数式として扱われうる
    expect(toCsvCell("@a")).toBe("'@a");
  });

  it("配列・オブジェクトは JSON 文字列として 1 セルに入れる", () => {
    expect(toCsvCell([1, 2, 3])).toBe('"[1,2,3]"');
    expect(toCsvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(toCsvCell([])).toBe("[]");
  });
});

describe("toCsv", () => {
  it("ヘッダー行 + データ行、改行は CRLF、末尾も CRLF", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          [1, "x"],
          [null, "y,z"],
        ],
      ),
    ).toBe('a,b\r\n1,x\r\n,"y,z"\r\n');
    expect(toCsv(["a"], [])).toBe("a\r\n");
  });

  it("性質: 任意の文字列を書き出して読み戻すと、数式の無害化以外は元の値に戻る", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ maxLength: 12 }), { minLength: 2, maxLength: 3 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (rows) => {
          const width = Math.min(...rows.map((row) => row.length));
          const trimmed = rows.map((row) => row.slice(0, width));
          const header = Array.from({ length: width }, (_, i) => `c${i}`);
          const parsed = parseCsv(toCsv(header, trimmed));
          expect(parsed[0]).toEqual(header);
          expect(parsed.slice(1)).toEqual(trimmed.map((row) => row.map(neutralizeFormula)));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("性質: 文字列セルで数式として解釈されうる先頭文字を持つものは出力に存在しない", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (value) => {
        const [, row] = parseCsv(toCsv(["x"], [[value]]));
        const cell = row?.[0] ?? "";
        expect(["=", "+", "-", "@", "\t", "\r"]).not.toContain(cell.charAt(0));
      }),
      { numRuns: 500 },
    );
  });
});
