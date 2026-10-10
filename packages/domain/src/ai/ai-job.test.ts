import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AI_JOB_STATUSES,
  NonCanonicalValueError,
  canonicalJson,
  decideAiJobClaim,
  isAiJobStatus,
  isTerminalAiJobStatus,
} from "./ai-job";

describe("isAiJobStatus / isTerminalAiJobStatus", () => {
  it("定義済みの status だけを受け付ける", () => {
    for (const status of AI_JOB_STATUSES) expect(isAiJobStatus(status)).toBe(true);
    for (const value of ["", "QUEUED", "done", null, undefined, 1, {}]) {
      expect(isAiJobStatus(value)).toBe(false);
    }
  });

  it("終端は succeeded / failed / fallback のみ", () => {
    expect(AI_JOB_STATUSES.filter(isTerminalAiJobStatus).sort()).toEqual([
      "failed",
      "fallback",
      "succeeded",
    ]);
  });
});

describe("decideAiJobClaim", () => {
  it.each([
    ["queued", false, "claim"],
    ["queued", true, "claim"],
    ["running", false, "in_progress"],
    ["running", true, "claim"],
    ["succeeded", false, "finished"],
    ["succeeded", true, "finished"],
    ["fallback", false, "finished"],
    ["fallback", true, "finished"],
    ["failed", false, "finished"],
    ["failed", true, "finished"],
  ] as const)("%s / lease 切れ=%s → %s", (status, leaseExpired, expected) => {
    expect(decideAiJobClaim({ status, leaseExpired })).toBe(expected);
  });

  it("性質: claim できるのは終端でない status のみで、終端は常に finished", () => {
    fc.assert(
      fc.property(fc.constantFrom(...AI_JOB_STATUSES), fc.boolean(), (status, leaseExpired) => {
        const decision = decideAiJobClaim({ status, leaseExpired });
        if (isTerminalAiJobStatus(status)) expect(decision).toBe("finished");
        else expect(decision === "claim" || decision === "in_progress").toBe(true);
      }),
    );
  });
});

describe("canonicalJson", () => {
  it("キーを辞書順に整列し、入れ子も同様にする", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,2]},"b":1}',
    );
  });

  it("配列の順序は保つ", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("undefined のプロパティは省略され、配列内の undefined は null になる", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
  });

  it("文字列のエスケープ(引用符・改行・サロゲートペア)を JSON と同じに扱う", () => {
    expect(canonicalJson({ k: 'a"b\n日本語😀' })).toBe(JSON.stringify({ k: 'a"b\n日本語😀' }));
  });

  it("値の違いで文字列が変わる(区切りの曖昧さがない)", () => {
    expect(canonicalJson({ a: "1,", b: "x" })).not.toBe(canonicalJson({ a: "1", b: ",x" }));
    expect(canonicalJson(["a,b"])).not.toBe(canonicalJson(["a", "b"]));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });

  it.each([
    ["関数", () => 1],
    ["symbol", Symbol("x")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined 単体", undefined],
  ])("%s は拒否する", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(NonCanonicalValueError);
  });

  it("循環参照は拒否し、同じオブジェクトの共有(循環でない)は許可する", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(NonCanonicalValueError);
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("性質: キーの挿入順に依らず同じ出力になる", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue(), { maxKeys: 8 }),
        (record) => {
          const reversed = Object.fromEntries(Object.entries(record).reverse());
          expect(canonicalJson(reversed)).toBe(canonicalJson(record));
        },
      ),
    );
  });

  it("性質: JSON 値は再パースすると元の値に戻る(情報を失わない)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });

  it("性質: 異なる JSON 値は異なる文字列になる(単射性)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        const same = JSON.stringify(canonicalSort(a)) === JSON.stringify(canonicalSort(b));
        expect(canonicalJson(a) === canonicalJson(b)).toBe(same);
      }),
    );
  });
});

/** 参照実装: 値を再帰的にキー整列した構造へ変換する(出力形式に依存しない比較用)。 */
function canonicalSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSort);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalSort(v)]),
    );
  }
  return value;
}
