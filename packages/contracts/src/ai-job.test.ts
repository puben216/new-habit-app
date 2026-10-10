import { describe, expect, it } from "vitest";
import {
  AI_JOB_FALLBACK_REASONS,
  aiJobIdParamSchema,
  aiJobMessageV1Schema,
  aiJobResponseSchema,
  aiJobResultV1Schema,
  requestWeeklyAnalysisBodySchema,
} from "./ai-job";

const ID = "5b0e4c1e-8a46-4a53-9d0c-0e1f6d7c9a10";

const plan = {
  schemaVersion: "1",
  summary: "今週の見直し案です。",
  observations: [{ evidence: "予定の半分を実施", interpretation: "流れができ始めている可能性" }],
  suggestions: [
    {
      title: "最小行動を小さくする",
      rationale: "難しい日にも取り組みやすくするため",
      changeType: "minimum_action",
      proposedValue: "1分だけ取り組む",
      confidence: "medium",
    },
  ],
  safety: { requiresHumanSupport: false, message: null },
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    source: "ai",
    output: plan,
    contentSafety: {
      status: "pass",
      reasonCodes: [],
      validatorVersion: "v1",
      fallbackVersion: null,
    },
    fallbackReason: null,
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    kind: "weekly_improvement",
    status: "succeeded",
    subject: { type: "weekly_review", id: ID },
    promptVersion: "weekly-improvement/1",
    outputSchemaVersion: "1",
    result: result(),
    failureCode: null,
    createdAt: "2026-01-14T00:00:00.000Z",
    updatedAt: "2026-01-14T00:00:05.000Z",
    ...overrides,
  };
}

describe("aiJobMessageV1Schema", () => {
  it("v=1 と UUID の jobId のみ受け付ける", () => {
    expect(aiJobMessageV1Schema.safeParse({ v: 1, jobId: ID }).success).toBe(true);
  });

  it.each([
    {},
    { v: 2, jobId: ID },
    { v: "1", jobId: ID },
    { v: 1 },
    { v: 1, jobId: "1" },
    { v: 1, jobId: ID, userId: "1" },
    { v: 1, jobId: ID, input: { reflection: "メモ" } },
    null,
    "text",
  ])("不正・余分な項目を含む message は拒否する: %j", (message) => {
    expect(aiJobMessageV1Schema.safeParse(message).success).toBe(false);
  });
});

describe("aiJobResultV1Schema", () => {
  it("ai と fallback の整合した組み合わせを受け付ける", () => {
    expect(aiJobResultV1Schema.safeParse(result()).success).toBe(true);
    for (const reason of AI_JOB_FALLBACK_REASONS) {
      expect(
        aiJobResultV1Schema.safeParse(result({ source: "fallback", fallbackReason: reason }))
          .success,
      ).toBe(true);
    }
  });

  it("source と fallbackReason が食い違うものは拒否する", () => {
    expect(aiJobResultV1Schema.safeParse(result({ fallbackReason: "disabled" })).success).toBe(
      false,
    );
    expect(aiJobResultV1Schema.safeParse(result({ source: "fallback" })).success).toBe(false);
    expect(
      aiJobResultV1Schema.safeParse(result({ source: "fallback", fallbackReason: "unknown" }))
        .success,
    ).toBe(false);
  });

  it("未知キー(生の応答・prompt の混入)と不正な output を拒否する", () => {
    expect(aiJobResultV1Schema.safeParse(result({ rawResponse: "..." })).success).toBe(false);
    expect(aiJobResultV1Schema.safeParse(result({ output: { summary: "x" } })).success).toBe(false);
    expect(aiJobResultV1Schema.safeParse(result({ schemaVersion: 2 })).success).toBe(false);
  });
});

describe("aiJobResponseSchema", () => {
  it("正しい応答を受け付ける(result は null も可)", () => {
    expect(aiJobResponseSchema.safeParse(job()).success).toBe(true);
    expect(aiJobResponseSchema.safeParse(job({ status: "queued", result: null })).success).toBe(
      true,
    );
    expect(
      aiJobResponseSchema.safeParse(
        job({ status: "failed", result: null, failureCode: "subject_unavailable" }),
      ).success,
    ).toBe(true);
  });

  it.each([
    { status: "done" },
    { kind: "other" },
    { failureCode: "boom" },
    { createdAt: "2026-01-14" },
    { subject: { type: "", id: ID } },
    { subject: { type: "weekly_review", id: "1" } },
  ])("不正な項目は拒否する: %j", (overrides) => {
    expect(aiJobResponseSchema.safeParse(job(overrides)).success).toBe(false);
  });
});

describe("aiJobIdParamSchema / requestWeeklyAnalysisBodySchema", () => {
  it("UUID のみ受け付ける", () => {
    expect(aiJobIdParamSchema.safeParse(ID).success).toBe(true);
    for (const value of ["1", "abc", "", `${ID}x`]) {
      expect(aiJobIdParamSchema.safeParse(value).success).toBe(false);
    }
  });

  it("body は空オブジェクトのみ(未知キーを拒否)", () => {
    expect(requestWeeklyAnalysisBodySchema.safeParse({}).success).toBe(true);
    expect(requestWeeklyAnalysisBodySchema.safeParse({ force: true }).success).toBe(false);
    expect(requestWeeklyAnalysisBodySchema.safeParse([]).success).toBe(false);
  });
});
