import {
  AiJobLimitReachedError,
  AiJobNotFoundError,
  AiQueueUnavailableError,
  AnalysisInputInvalidError,
  UserNotFoundError,
  WeeklyReviewNotCompletedError,
  WeeklyReviewNotFoundError,
} from "@habit-app/application";
import type { AiJob } from "@habit-app/application";
import { aiJobResponseSchema } from "@habit-app/contracts";
import { describe, expect, it, vi } from "vitest";

import { createAiJobHandlers } from "./ai-job-handlers";
import type { AiJobUseCases } from "./ai-job-handlers";

const ORIGIN = "https://app.example.test";
const NOW = new Date("2026-01-14T03:00:00.000Z");
const REVIEW_ID = "10000000-0000-4000-8000-000000000001";
const JOB_ID = "20000000-0000-4000-8000-000000000001";

const queuedJob: AiJob = {
  id: JOB_ID,
  kind: "weekly_improvement",
  status: "queued",
  subject: { type: "weekly_review", id: REVIEW_ID },
  promptVersion: "weekly-improvement/1",
  outputSchemaVersion: "1",
  result: null,
  failureCode: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const succeededJob: AiJob = {
  ...queuedJob,
  status: "succeeded",
  result: {
    schemaVersion: 1,
    source: "ai",
    output: {
      schemaVersion: "1",
      summary: "今週の見直し案です。",
      observations: [],
      suggestions: [],
      safety: { requiresHumanSupport: false, message: null },
    },
    contentSafety: {
      status: "pass",
      reasonCodes: [],
      validatorVersion: "v1",
      fallbackVersion: null,
    },
    fallbackReason: null,
  },
};

function setup(options: { actor?: string | null } = {}) {
  const useCases = {
    requestAnalysis: vi.fn<AiJobUseCases["requestAnalysis"]>(async () => ({
      job: queuedJob,
      created: true,
    })),
    get: vi.fn<AiJobUseCases["get"]>(async () => succeededJob),
  };
  const handlers = createAiJobHandlers({
    allowedOrigin: ORIGIN,
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    useCases,
  });
  return { handlers, useCases };
}

const reviewParams = { reviewId: REVIEW_ID };
const analysisUrl = `${ORIGIN}/api/v1/weekly-reviews/${REVIEW_ID}/analysis`;

function postRequest(body: BodyInit | null = null, headers: Record<string, string> = {}): Request {
  return new Request(analysisUrl, {
    method: "POST",
    headers: { origin: ORIGIN, ...headers },
    body,
  });
}

async function problem(response: Response) {
  return (await response.json()) as { code: string; message: string };
}

describe("POST /weekly-reviews/{reviewId}/analysis", () => {
  it("新規作成は 202 と Location、no-store。内部情報を含まない", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.requestAnalysis(postRequest(), reviewParams);

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/ai-jobs/${JOB_ID}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = aiJobResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ id: JOB_ID, status: "queued", result: null });
    expect(Object.keys(body).sort()).toEqual(
      [
        "createdAt",
        "failureCode",
        "id",
        "kind",
        "outputSchemaVersion",
        "promptVersion",
        "result",
        "status",
        "subject",
        "updatedAt",
      ].sort(),
    );
    expect(useCases.requestAnalysis).toHaveBeenCalledWith({
      actorUserId: "42",
      reviewId: REVIEW_ID,
    });
  });

  it("既存の job は 200", async () => {
    const { handlers, useCases } = setup();
    useCases.requestAnalysis.mockResolvedValueOnce({ job: succeededJob, created: false });
    const response = await handlers.requestAnalysis(postRequest(), reviewParams);
    expect(response.status).toBe(200);
    expect(aiJobResponseSchema.parse(await response.json()).status).toBe("succeeded");
  });

  it("body なし・空オブジェクトの JSON のどちらも受け付ける", async () => {
    const { handlers, useCases } = setup();
    const empty = await handlers.requestAnalysis(
      postRequest("{}", { "content-type": "application/json" }),
      reviewParams,
    );
    expect(empty.status).toBe(202);
    const none = await handlers.requestAnalysis(postRequest(null), reviewParams);
    expect(none.status).toBe(202);
    expect(useCases.requestAnalysis).toHaveBeenCalledTimes(2);
  });

  it("未知キーを含む body は 422、Content-Type 不正は 415、大きすぎる body は 413", async () => {
    const { handlers, useCases } = setup();
    const extra = await handlers.requestAnalysis(
      postRequest('{"force":true}', { "content-type": "application/json" }),
      reviewParams,
    );
    expect(extra.status).toBe(422);
    const wrongType = await handlers.requestAnalysis(
      postRequest("x", { "content-type": "text/plain" }),
      reviewParams,
    );
    expect(wrongType.status).toBe(415);
    const large = await handlers.requestAnalysis(
      postRequest(JSON.stringify({ pad: "x".repeat(20_000) }), {
        "content-type": "application/json",
      }),
      reviewParams,
    );
    expect(large.status).toBe(413);
    expect(useCases.requestAnalysis).not.toHaveBeenCalled();
  });

  it("未認証は 401、Origin が不正なら 403(いずれも use case を呼ばない)", async () => {
    const anonymous = setup({ actor: null });
    expect((await anonymous.handlers.requestAnalysis(postRequest(), reviewParams)).status).toBe(
      401,
    );
    expect(anonymous.useCases.requestAnalysis).not.toHaveBeenCalled();

    const { handlers, useCases } = setup();
    const evil = await handlers.requestAnalysis(
      postRequest(null, { origin: "https://evil.example" }),
      reviewParams,
    );
    expect(evil.status).toBe(403);
    expect(useCases.requestAnalysis).not.toHaveBeenCalled();
  });

  it("UUID 形式でない reviewId は use case を呼ばず 404", async () => {
    const { handlers, useCases } = setup();
    for (const reviewId of ["1", "abc", "../x", "' OR 1=1 --"]) {
      const response = await handlers.requestAnalysis(postRequest(), { reviewId });
      expect(response.status).toBe(404);
      expect((await problem(response)).code).toBe("weekly_review_not_found");
    }
    expect(useCases.requestAnalysis).not.toHaveBeenCalled();
  });

  it.each([
    [new WeeklyReviewNotFoundError(), 404, "weekly_review_not_found"],
    [new WeeklyReviewNotCompletedError(), 409, "weekly_review_not_completed"],
    [new AnalysisInputInvalidError(), 422, "analysis_input_invalid"],
    [new AiJobLimitReachedError(), 429, "ai_job_limit_reached"],
    [new AiQueueUnavailableError(), 503, "queue_unavailable"],
    [new UserNotFoundError(), 404, "user_not_found"],
  ])("%s を HTTP に変換する", async (error, status, code) => {
    const { handlers, useCases } = setup();
    useCases.requestAnalysis.mockRejectedValueOnce(error);
    const response = await handlers.requestAnalysis(postRequest(), reviewParams);
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
  });

  it("未知のエラーは握りつぶさず再 throw する(内部詳細を応答へ出さない)", async () => {
    const { handlers, useCases } = setup();
    useCases.requestAnalysis.mockRejectedValueOnce(new Error("secret internal detail"));
    await expect(handlers.requestAnalysis(postRequest(), reviewParams)).rejects.toThrow(
      "secret internal detail",
    );
  });
});

describe("GET /ai-jobs/{jobId}", () => {
  const params = { jobId: JOB_ID };
  const getRequest = () => new Request(`${ORIGIN}/api/v1/ai-jobs/${JOB_ID}`);

  it("200 で job と結果を返す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.get(getRequest(), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = aiJobResponseSchema.parse(await response.json());
    expect(body.result?.source).toBe("ai");
    expect(useCases.get).toHaveBeenCalledWith({ actorUserId: "42", jobId: JOB_ID });
  });

  it("failed の job は failureCode を返す", async () => {
    const { handlers, useCases } = setup();
    useCases.get.mockResolvedValueOnce({
      ...queuedJob,
      status: "failed",
      failureCode: "subject_unavailable",
    });
    const body = aiJobResponseSchema.parse(await (await handlers.get(getRequest(), params)).json());
    expect(body).toMatchObject({
      status: "failed",
      failureCode: "subject_unavailable",
      result: null,
    });
  });

  it("未知の failure_code(データ破損)は 500 相当(再 throw)で、値を応答に出さない", async () => {
    const { handlers, useCases } = setup();
    useCases.get.mockResolvedValueOnce({ ...queuedJob, status: "failed", failureCode: "boom" });
    await expect(handlers.get(getRequest(), params)).rejects.toThrow();
  });

  it("UUID 形式でない ID は use case を呼ばず 404、他人・存在しない job も 404", async () => {
    const { handlers, useCases } = setup();
    const invalid = await handlers.get(getRequest(), { jobId: "nope" });
    expect(invalid.status).toBe(404);
    expect(useCases.get).not.toHaveBeenCalled();

    useCases.get.mockRejectedValueOnce(new AiJobNotFoundError());
    const missing = await handlers.get(getRequest(), params);
    expect(missing.status).toBe(404);
    expect((await problem(missing)).code).toBe("ai_job_not_found");
  });

  it("未認証は 401", async () => {
    const { handlers, useCases } = setup({ actor: null });
    expect((await handlers.get(getRequest(), params)).status).toBe(401);
    expect(useCases.get).not.toHaveBeenCalled();
  });
});
