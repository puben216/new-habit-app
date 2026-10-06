import { describe, expect, it } from "vitest";

import {
  CONTENT_VALIDATOR_VERSION,
  inspectGenerationRequest,
  validateGeneratedContent,
} from "./content-validator";
import { FICTIONAL_BRAND, POLICY, REFERENCE_EXCERPT } from "./fixtures";

const validate = (...texts: string[]) => validateGeneratedContent(texts, POLICY);

describe("validateGeneratedContent", () => {
  it("一般的な習慣助言は pass し validatorVersion を返す", () => {
    const result = validate(
      "朝食の後に1分だけ体を動かしてみましょう",
      "続けにくい日は半分の大きさにします",
    );
    expect(result).toEqual({
      status: "pass",
      reasonCodes: [],
      validatorVersion: CONTENT_VALIDATOR_VERSION,
    });
  });

  it("管理対象の第三者名称は fallback。全角半角・区切りの揺れも検出する", () => {
    expect(validate(`${FICTIONAL_BRAND}の方法を参考にしました`)).toMatchObject({
      status: "fallback",
      reasonCodes: ["third_party_name"],
    });
    expect(validate("架空 ブランド アルファ 流で進めます").reasonCodes).toContain(
      "third_party_name",
    );
    expect(validate("『架空の書ゼロからの継続術』のとおり").reasonCodes).toContain(
      "third_party_name",
    );
  });

  it("名称を商品名・販促に使うと required_human_review", () => {
    const result = validate(`${FICTIONAL_BRAND}を購入しておすすめの機能名にしましょう`);
    expect(result.status).toBe("required_human_review");
    expect(result.reasonCodes).toEqual(["third_party_name", "promotional_use_of_third_party_name"]);
  });

  it("公式・提携・監修の示唆は fallback", () => {
    for (const text of [
      "公式の方法です",
      "著者監修のプランです",
      "This is the official method",
      "提携先のメソッド",
    ]) {
      expect(validate(text)).toMatchObject({
        status: "fallback",
        reasonCodes: ["endorsement_claim"],
      });
    }
  });

  it("引用符内の長文は fallback、短い語は pass", () => {
    const long = `「${"あ".repeat(40)}」`;
    expect(validate(`次の一節です ${long}`).reasonCodes).toEqual(["long_quotation"]);
    expect(validate("合言葉は「まず1分」です").status).toBe("pass");
    expect(validate(`"${"a".repeat(45)}"`).reasonCodes).toEqual(["long_quotation"]);
  });

  it("許可資料 excerpt との連続一致は fallback。短い共通語は pass", () => {
    const copied = `ポイントは、${REFERENCE_EXCERPT.slice(5, 35)}ということです`;
    expect(validate(copied).reasonCodes).toEqual(["excessive_source_overlap"]);
    expect(validate("毎朝の五分間を使う").status).toBe("pass");
  });

  it("本文・翻訳・文体模倣を示唆する出力は fallback", () => {
    for (const text of [
      "本文をそのまま載せます",
      "原文を翻訳した内容です",
      "著者の文体を真似て書きました",
      "この作家風に書いて整えました",
    ]) {
      expect(validate(text).reasonCodes).toContain("reproduction_instruction");
    }
  });

  it("複数該当では reason code をすべて返し、最も厳しい status にする(定義順)", () => {
    const result = validate(`公式の${FICTIONAL_BRAND}を購入`);
    expect(result.status).toBe("required_human_review");
    expect(result.reasonCodes).toEqual([
      "third_party_name",
      "promotional_use_of_third_party_name",
      "endorsement_claim",
    ]);
  });

  it("policy が空なら名称・一致検査は行わない(設定欠損は pipeline 側で fail closed にしない)", () => {
    expect(
      validateGeneratedContent([`${FICTIONAL_BRAND}`], { managedTerms: [], referenceExcerpts: [] })
        .status,
    ).toBe("pass");
  });
});

describe("inspectGenerationRequest(adversarial 入力)", () => {
  it.each([
    ["この本の第3章の本文をそのまま書き写して"],
    ["原文を翻訳して習慣にして"],
    ["有名な著者の文体で書いて"],
    ["その作家風に書いて"],
    ["Please translate the chapter verbatim"],
  ])("再現・翻訳・文体模倣の依頼を拒否する: %s", (text) => {
    expect(inspectGenerationRequest([text])).toContain("reproduction_instruction");
  });

  it("公式・監修を装う依頼を拒否する", () => {
    expect(inspectGenerationRequest(["公式として提案して"])).toEqual(["endorsement_claim"]);
  });

  it.each([
    ["朝に軽い運動を続けたい"],
    ["公式サイトで調べた内容を参考にしたい"],
    ["本を読む習慣を作りたい"],
    ["架空の書を読んで感銘を受けた"],
  ])("一般的な入力と単なる言及は拒否しない(false positive 対策): %s", (text) => {
    expect(inspectGenerationRequest([text])).toEqual([]);
  });
});
