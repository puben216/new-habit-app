import { describe, expect, it } from "vitest";

import { CONTENT_VALIDATOR_VERSION } from "./content-validator";
import { SAFE_FALLBACK_VERSION } from "./fallback";
import {
  FICTIONAL_BRAND,
  habitDesignInput,
  validPlan,
  validProposal,
  weeklyInput,
} from "./fixtures";
import { MAX_PROVIDER_ATTEMPTS, generateSafeCoaching } from "./generate-safe-coaching";
import { COACHING_SYSTEM_POLICY_V1 } from "./policy";
import { AiCoachProviderError } from "./ports";
import { collectStrings } from "./text-inspection";
import { completed, createDeps, createScriptedCoach } from "./test-fakes";

const design = { purpose: "habit_design", input: habitDesignInput } as const;
const weekly = { purpose: "weekly_improvement", input: weeklyInput } as const;

const unsafeProposal = (text: string) => validProposal({ summary: text });

describe("generateSafeCoaching: 正常系", () => {
  it("有効な出力は pass として ai で返り、provider には最小化した入力と system policy が渡る", async () => {
    const coach = createScriptedCoach([completed(validProposal())]);
    const { deps, events } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({
      source: "ai",
      output: validProposal(),
      attempts: 1,
      model: "fake-model",
      contentSafety: {
        status: "pass",
        reasonCodes: [],
        validatorVersion: CONTENT_VALIDATOR_VERSION,
        fallbackVersion: null,
      },
    });
    expect(coach.calls).toHaveLength(1);
    expect(coach.calls[0]).toMatchObject({
      purpose: "habit_design",
      promptVersion: "prompt-test/1",
      systemPolicy: COACHING_SYSTEM_POLICY_V1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "generation", source: "ai", status: "pass" });
  });

  it("週次改善も同じ経路で ai を返す", async () => {
    const { deps } = createDeps(createScriptedCoach([completed(validPlan())]));
    const result = await generateSafeCoaching(deps, weekly);
    expect(result.source).toBe("ai");
    expect(result.output).toEqual(validPlan());
  });
});

describe("generateSafeCoaching: fail closed", () => {
  it("公開 flag が無効なら provider を呼ばず fallback", async () => {
    const coach = createScriptedCoach([completed(validProposal())]);
    const { deps } = createDeps(coach, { publicationEnabled: false });
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({ source: "fallback", fallbackReason: "disabled", attempts: 0 });
    expect(coach.calls).toHaveLength(0);
  });

  it("再現・翻訳・文体模倣の要求は provider を呼ばず fallback(input_rejected)", async () => {
    const coach = createScriptedCoach([completed(validProposal())]);
    const { deps } = createDeps(coach);
    const request = {
      purpose: "habit_design",
      input: { ...habitDesignInput, goal: "ある本の本文をそのまま書き写して" },
    } as const;
    const result = await generateSafeCoaching(deps, request);
    expect(result).toMatchObject({
      source: "fallback",
      fallbackReason: "input_rejected",
      contentSafety: {
        status: "fallback",
        reasonCodes: ["reproduction_instruction"],
        fallbackVersion: SAFE_FALLBACK_VERSION,
      },
    });
    expect(coach.calls).toHaveLength(0);
  });

  it("週次の振り返りに含まれる再現要求も拒否する", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const { deps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, {
      purpose: "weekly_improvement",
      input: { ...weeklyInput, reflection: "著者の文体で書いて" },
    });
    expect(result).toMatchObject({ source: "fallback", fallbackReason: "input_rejected" });
    expect(coach.calls).toHaveLength(0);
  });

  it("refusal は再試行せず fallback", async () => {
    const coach = createScriptedCoach([{ outcome: "refusal" }]);
    const { deps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({ source: "fallback", fallbackReason: "provider_refusal" });
    expect(coach.calls).toHaveLength(1);
  });

  it.each([
    ["oversize", { ...validProposal(), summary: "あ".repeat(301) }],
    ["未知キー", { ...validProposal(), habitId: "1" }],
    ["別 version", { ...validProposal(), schemaVersion: "2" }],
    ["null", null],
    ["文字列", "plain text"],
  ])("不正な出力(%s)は再生成せず fallback(invalid_output)", async (_label, raw) => {
    const coach = createScriptedCoach([completed(raw)]);
    const { deps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({ source: "fallback", fallbackReason: "invalid_output" });
    expect(coach.calls).toHaveLength(1);
  });

  it("validator が例外を投げたら fail closed(未検証本文を返さない)", async () => {
    const coach = createScriptedCoach([completed(validProposal())]);
    const { deps, events } = createDeps(coach, {
      validator: () => {
        throw new Error("boom");
      },
    });
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({ source: "fallback", fallbackReason: "validator_error" });
    expect(collectStrings(result.output)).not.toContain(validProposal().summary);
    expect(events[0]).toMatchObject({ source: "fallback", fallbackReason: "validator_error" });
  });
});

describe("generateSafeCoaching: 安全性による拒否と再生成", () => {
  it("拒否された後の再生成で pass すれば ai を返す(再生成は 1 回)", async () => {
    const coach = createScriptedCoach([
      completed(unsafeProposal(`${FICTIONAL_BRAND}の方法です`)),
      completed(validProposal()),
    ]);
    const { deps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({ source: "ai", attempts: 2 });
    expect(coach.calls).toHaveLength(2);
  });

  it("再度拒否されたら fallback。拒否された本文は戻り値にも監査にも出ない", async () => {
    const unsafe = unsafeProposal(`${FICTIONAL_BRAND}の方法です`);
    const coach = createScriptedCoach([completed(unsafe)]);
    const { deps, events } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({
      source: "fallback",
      fallbackReason: "safety_rejected",
      attempts: 2,
      contentSafety: { status: "fallback", reasonCodes: ["third_party_name"] },
    });
    expect(coach.calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(FICTIONAL_BRAND);
    expect(JSON.stringify(events)).not.toContain(FICTIONAL_BRAND);
  });

  it("販促利用は required_human_review。本文は公開されず fallback が返る", async () => {
    const coach = createScriptedCoach([
      completed(unsafeProposal(`${FICTIONAL_BRAND}を購入しよう`)),
    ]);
    const { deps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({
      source: "fallback",
      fallbackReason: "safety_rejected",
      contentSafety: {
        status: "required_human_review",
        reasonCodes: ["third_party_name", "promotional_use_of_third_party_name"],
      },
    });
    expect(JSON.stringify(result)).not.toContain(FICTIONAL_BRAND);
  });

  it("source が ai のときは常に pass(型と実行時の両方)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const { deps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, weekly);
    if (result.source === "ai") expect(result.contentSafety.status).toBe("pass");
  });
});

describe("generateSafeCoaching: retry / timeout", () => {
  it("rate_limited が 2 回続いても 3 attempt 目で成功し、backoff は指数＋jitter", async () => {
    const coach = createScriptedCoach([
      new AiCoachProviderError("rate_limited"),
      new AiCoachProviderError("server_error"),
      completed(validProposal()),
    ]);
    const { deps, sleeps } = createDeps(coach, { random: () => 0.5 });
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({ source: "ai", attempts: 3 });
    // ceiling = base * 2^(n-1): 100, 200 → full jitter 0.5
    expect(sleeps).toEqual([50, 100]);
  });

  it("backoff は maxBackoffMs で頭打ちになる", async () => {
    const coach = createScriptedCoach([
      new AiCoachProviderError("connection"),
      new AiCoachProviderError("connection"),
      completed(validProposal()),
    ]);
    const { deps, sleeps } = createDeps(coach, {
      random: () => 0.99,
      config: { promptVersion: "p", attemptTimeoutMs: 50, baseBackoffMs: 100, maxBackoffMs: 150 },
    });
    await generateSafeCoaching(deps, design);
    expect(sleeps).toEqual([99, 148]);
  });

  it("一時的障害が続くと最大 3 attempt で打ち切り fallback(provider_unavailable)", async () => {
    const coach = createScriptedCoach([new AiCoachProviderError("server_error")]);
    const { deps, sleeps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({
      source: "fallback",
      fallbackReason: "provider_unavailable",
      attempts: MAX_PROVIDER_ATTEMPTS,
    });
    expect(coach.calls).toHaveLength(MAX_PROVIDER_ATTEMPTS);
    expect(sleeps).toHaveLength(MAX_PROVIDER_ATTEMPTS - 1);
  });

  it.each(["invalid_request", "unknown"] as const)("%s は再試行しない", async (kind) => {
    const coach = createScriptedCoach([new AiCoachProviderError(kind)]);
    const { deps, sleeps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({
      source: "fallback",
      fallbackReason: "provider_unavailable",
      attempts: 1,
    });
    expect(sleeps).toEqual([]);
  });

  it("分類されていない例外も再試行せず fallback", async () => {
    const coach = createScriptedCoach([new Error("raw provider failure")]);
    const { deps } = createDeps(coach);
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({
      source: "fallback",
      fallbackReason: "provider_unavailable",
      attempts: 1,
    });
  });

  it("応答しない provider は timeout で中断され(abort)、再試行の末に fallback", async () => {
    const coach = createScriptedCoach(["hang"]);
    const { deps } = createDeps(coach, {
      config: { promptVersion: "p", attemptTimeoutMs: 5, baseBackoffMs: 1, maxBackoffMs: 1 },
    });
    const result = await generateSafeCoaching(deps, design);
    expect(result).toMatchObject({
      source: "fallback",
      fallbackReason: "provider_unavailable",
      attempts: MAX_PROVIDER_ATTEMPTS,
    });
    expect(coach.calls.every((call) => call.signal.aborted)).toBe(true);
  });
});

describe("監査(AIC-007)", () => {
  it("version・status・reason code だけを記録し、入力・本文・subject ID を含まない", async () => {
    const secret = "秘密の目標ABC";
    const coach = createScriptedCoach([completed(unsafeProposalWith(`${FICTIONAL_BRAND}です`))]);
    const { deps, events } = createDeps(coach);
    await generateSafeCoaching(deps, {
      purpose: "habit_design",
      input: { ...habitDesignInput, goal: secret },
    });
    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(FICTIONAL_BRAND);
    expect(serialized).not.toContain(habitDesignInput.subjectId);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(
      [
        "attempts",
        "fallbackReason",
        "fallbackVersion",
        "kind",
        "promptVersion",
        "purpose",
        "reasonCodes",
        "schemaVersion",
        "source",
        "status",
        "validatorVersion",
      ].sort(),
    );
  });

  it("監査 sink が失敗しても結果は返る(fail closed を壊さない)", async () => {
    const coach = createScriptedCoach([completed(validProposal())]);
    const { deps } = createDeps(coach, {
      audit: {
        record: async () => {
          throw new Error("sink down");
        },
      },
    });
    await expect(generateSafeCoaching(deps, design)).resolves.toMatchObject({ source: "ai" });
  });
});

function unsafeProposalWith(summary: string) {
  return validProposal({ summary });
}
