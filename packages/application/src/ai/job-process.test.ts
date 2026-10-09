import { aiJobResultV1Schema } from "@habit-app/contracts";
import { describe, expect, it } from "vitest";

import { FICTIONAL_BRAND, validPlan } from "./fixtures";
import { handleAiJobMessages } from "./job-handler";
import type { AiJobRecord } from "./job-ports";
import { setupAiJobTest, USER_A } from "./job-test-setup";
import {
  AI_JOB_LEASE_SECONDS,
  AI_JOB_MAX_RECEIVE,
  getAiJobUseCase,
  processAiJobUseCase,
  requestWeeklyAnalysisUseCase,
} from "./job-use-cases";
import { AiCoachProviderError } from "./ports";
import type { AiCoachPort } from "./ports";
import { completed, createScriptedCoach } from "./test-fakes";

async function queuedJob(s: ReturnType<typeof setupAiJobTest>, options?: { reflection?: string }) {
  await s.createHabit(USER_A, "水を飲む");
  const reviewId = await s.createReview(USER_A, options);
  const { job } = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
    actorUserId: USER_A,
    reviewId,
  });
  return { jobId: job.id, reviewId };
}

const stored = (s: ReturnType<typeof setupAiJobTest>, jobId: string): AiJobRecord => {
  const job = s.jobRepository.jobs.get(jobId);
  if (job === undefined) throw new Error("job missing");
  return job;
};

describe("processAiJobUseCase: 正常系", () => {
  it("claim → generateSafeCoaching → succeeded で確定し、検証済みの結果と attempt を保存する", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);

    const outcome = await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });

    expect(outcome).toBe("done");
    const job = stored(s, jobId);
    expect(job.status).toBe("succeeded");
    expect(job.model).toBe("fake-model");
    const result = aiJobResultV1Schema.parse(job.result);
    expect(result).toMatchObject({ source: "ai", fallbackReason: null });
    expect(result.output).toEqual(validPlan());
    expect(s.jobRepository.attempts).toHaveLength(1);
    expect(s.jobRepository.attempts[0]?.attempt).toMatchObject({
      outcome: "succeeded",
      errorCategory: null,
    });
  });

  it("provider には最小化した入力だけが渡る(subjectId は job の ID、内部 ID・email を含まない)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId, reviewId } = await queuedJob(s, { reflection: "よく続いた" });
    await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });

    const call = coach.calls[0];
    if (call === undefined || call.purpose !== "weekly_improvement") throw new Error("no call");
    expect(call.input.subjectId).toBe(jobId);
    expect(call.input.reflection).toBe("よく続いた");
    expect(call.input.habits[0]).toMatchObject({
      name: "水を飲む",
      cue: "起床直後",
      minimumAction: "コップ1杯",
    });
    const text = JSON.stringify(call.input);
    expect(text).not.toContain(reviewId);
    expect(text).not.toContain("健康維持");
    expect(text).not.toContain(USER_A === "1" ? '"userId"' : USER_A);
  });

  it("API 経由の取得で、結果が AiJob として読める", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId } = await queuedJob(s);
    await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });
    const job = await getAiJobUseCase(
      { jobRepository: s.jobRepository },
      { actorUserId: USER_A, jobId },
    );
    expect(job.status).toBe("succeeded");
    expect(job.result?.source).toBe("ai");
  });
});

describe("processAiJobUseCase: 重複配送と claim", () => {
  it("同じ message が 2 回届いても provider は 1 回、job は 1 回だけ確定する", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);

    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 })).toBe("done");
    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 2 })).toBe("done");

    expect(coach.calls).toHaveLength(1);
    expect(s.jobRepository.attempts).toHaveLength(1);
  });

  it("存在しない job は何もせず done(ack)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const outcome = await processAiJobUseCase(s.processDeps(), {
      jobId: "20000000-0000-4000-8000-ffffffffffff",
      receiveCount: 1,
    });
    expect(outcome).toBe("done");
    expect(coach.calls).toHaveLength(0);
  });

  it("lease 内の running は処理せず retry(provider を呼ばない)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);
    s.jobRepository.seed({ ...stored(s, jobId), status: "running" }, s.clock());
    s.setNow("2026-01-14T03:04:59Z"); // lease 開始(03:00:00)から 299 秒

    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 })).toBe("retry");
    expect(coach.calls).toHaveLength(0);
    expect(stored(s, jobId).status).toBe("running");
  });

  it("lease を過ぎた running は引き継いで確定する(境界は lease 秒数の超過)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);
    s.jobRepository.seed({ ...stored(s, jobId), status: "running" }, s.clock());
    s.setNow(new Date(s.clock().getTime() + AI_JOB_LEASE_SECONDS * 1000 + 1).toISOString());

    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 2 })).toBe("done");
    expect(stored(s, jobId).status).toBe("succeeded");
  });

  it("claim 自体が例外でも throw せず retry", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId } = await queuedJob(s);
    s.jobRepository.failNext("claim");
    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 })).toBe("retry");
    expect(stored(s, jobId).status).toBe("queued");
  });

  it("確定時に lease を奪われていた(lost)場合は結果を書かず done", async () => {
    // 実行中に別 worker が先に確定した状況を再現する。
    let interfere: () => void = () => {};
    const coach: AiCoachPort = {
      async generate() {
        interfere();
        return completed(validPlan());
      },
    };
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);
    interfere = () =>
      s.jobRepository.seed({ ...stored(s, jobId), status: "succeeded", result: { by: "other" } });

    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 })).toBe("done");
    expect(stored(s, jobId).result).toEqual({ by: "other" });
    expect(s.jobRepository.attempts).toHaveLength(0);
  });
});

describe("processAiJobUseCase: fallback", () => {
  it("provider が 429 を返し続けたら 3 attempt のあと fallback(provider_unavailable)で確定し ack", async () => {
    const coach = createScriptedCoach([new AiCoachProviderError("rate_limited")]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);

    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 })).toBe("done");

    expect(coach.calls).toHaveLength(3);
    expect(s.sleeps).toHaveLength(2);
    const job = stored(s, jobId);
    expect(job.status).toBe("fallback");
    expect(aiJobResultV1Schema.parse(job.result)).toMatchObject({
      source: "fallback",
      fallbackReason: "provider_unavailable",
    });
    expect(s.jobRepository.attempts[0]?.attempt).toMatchObject({
      outcome: "fallback",
      errorCategory: "provider_unavailable",
    });
  });

  it.each([
    ["refusal", [{ outcome: "refusal" } as const], "provider_refusal"],
    ["不正な出力", [completed({ summary: "x" })], "invalid_output"],
    ["400 系", [new AiCoachProviderError("invalid_request")], "provider_unavailable"],
  ])("%s は fallback(%s)で確定する", async (_label, script, reason) => {
    const s = setupAiJobTest(createScriptedCoach(script));
    const { jobId } = await queuedJob(s);
    await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });
    expect(stored(s, jobId).status).toBe("fallback");
    expect(aiJobResultV1Schema.parse(stored(s, jobId).result).fallbackReason).toBe(reason);
  });

  it("公開 flag が無効なら provider を呼ばず fallback(disabled)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach, { publicationEnabled: false });
    const { jobId } = await queuedJob(s);
    await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });
    expect(coach.calls).toHaveLength(0);
    expect(aiJobResultV1Schema.parse(stored(s, jobId).result).fallbackReason).toBe("disabled");
  });

  it("安全性検査で再生成後も拒否される出力は fallback(safety_rejected)で、拒否された本文を保存しない", async () => {
    const unsafe = validPlan({ summary: `${FICTIONAL_BRAND}の方法です` });
    const coach = createScriptedCoach([completed(unsafe)]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);

    await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });

    const job = stored(s, jobId);
    expect(job.status).toBe("fallback");
    expect(aiJobResultV1Schema.parse(job.result).fallbackReason).toBe("safety_rejected");
    expect(coach.calls).toHaveLength(2);
    expect(JSON.stringify(job.result)).not.toContain(FICTIONAL_BRAND);
    expect(JSON.stringify(s.events)).not.toContain(FICTIONAL_BRAND);
  });
});

describe("processAiJobUseCase: 入力元の問題", () => {
  it("レビューが消えていたら failed(subject_unavailable)で確定し ack", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);
    (s.reviewRepository.reviews as Map<string, unknown>).clear();

    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 })).toBe("done");
    expect(coach.calls).toHaveLength(0);
    expect(stored(s, jobId)).toMatchObject({
      status: "failed",
      failureCode: "subject_unavailable",
    });
    expect(s.jobRepository.attempts[0]?.attempt.outcome).toBe("failed");
  });

  it("レビューが確定していなければ failed(subject_unavailable)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);
    const key = `${USER_A}:2026-01-05`;
    const review = s.reviewRepository.reviews.get(key);
    if (review === undefined) throw new Error("review missing");
    s.reviewRepository.seed(USER_A, { ...review, status: "draft", completedAt: null });

    await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });
    expect(stored(s, jobId)).toMatchObject({
      status: "failed",
      failureCode: "subject_unavailable",
    });
  });

  it("入力を組み立てられなければ failed(invalid_input)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);
    const key = `${USER_A}:2026-01-05`;
    const review = s.reviewRepository.reviews.get(key);
    if (review === undefined) throw new Error("review missing");
    s.reviewRepository.seed(USER_A, { ...review, reflection: "a\u0000b" });

    await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });
    expect(stored(s, jobId)).toMatchObject({ status: "failed", failureCode: "invalid_input" });
    expect(coach.calls).toHaveLength(0);
  });
});

describe("processAiJobUseCase: worker の予期しない失敗", () => {
  it("確定が例外なら job を queued に戻して retry(attempt は error)。次の配送で完了する", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);
    s.jobRepository.failNext("complete");

    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 })).toBe("retry");
    expect(stored(s, jobId).status).toBe("queued");
    expect(s.jobRepository.attempts[0]?.attempt).toMatchObject({
      outcome: "error",
      errorCategory: "worker_error",
    });

    expect(await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 2 })).toBe("done");
    expect(stored(s, jobId).status).toBe("succeeded");
  });

  it(`受信回数が ${AI_JOB_MAX_RECEIVE} に達した失敗は fallback(worker_exhausted)で確定して ack`, async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId } = await queuedJob(s);
    s.jobRepository.failNext("complete"); // 通常の確定だけが失敗し、回復の確定は成功する

    expect(
      await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: AI_JOB_MAX_RECEIVE }),
    ).toBe("done");
    const job = stored(s, jobId);
    expect(job.status).toBe("fallback");
    expect(aiJobResultV1Schema.parse(job.result)).toMatchObject({
      source: "fallback",
      fallbackReason: "worker_exhausted",
    });
    expect(s.jobRepository.attempts[0]?.attempt).toMatchObject({
      outcome: "fallback",
      errorCategory: "worker_exhausted",
    });
  });

  it("受信上限未満では exhausted にしない(上限 - 1 は retry)", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId } = await queuedJob(s);
    s.jobRepository.failNext("complete");
    expect(
      await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: AI_JOB_MAX_RECEIVE - 1 }),
    ).toBe("retry");
    expect(stored(s, jobId).status).toBe("queued");
  });

  it("受信上限でも確定に失敗し続ければ retry(DLQ へ)で、例外は投げない", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId } = await queuedJob(s);
    s.jobRepository.failNext("complete", 2);
    await expect(
      processAiJobUseCase(s.processDeps(), { jobId, receiveCount: AI_JOB_MAX_RECEIVE }),
    ).resolves.toBe("retry");
  });

  it("release も失敗しても throw せず retry", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId } = await queuedJob(s);
    s.jobRepository.failNext("complete");
    s.jobRepository.failNext("release");
    await expect(processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 })).resolves.toBe(
      "retry",
    );
  });
});

describe("processAiJobUseCase: 監査", () => {
  it("監査イベントは 1 件で、入力・本文・subject を含まない", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId, reviewId } = await queuedJob(s, { reflection: "秘密の振り返り" });
    await processAiJobUseCase(s.processDeps(), { jobId, receiveCount: 1 });
    expect(s.events).toHaveLength(1);
    const text = JSON.stringify(s.events);
    expect(text).not.toContain("秘密の振り返り");
    expect(text).not.toContain(reviewId);
    expect(text).not.toContain(jobId);
  });
});

describe("handleAiJobMessages", () => {
  const body = (jobId: string) => JSON.stringify({ v: 1, jobId });

  it("成功した record は失敗に含めず、不正な message・処理待ちの record だけを返す", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const first = await queuedJob(s);
    const inProgress = await (async () => {
      const reviewId = await s.createReview(USER_A, { weekStart: "2025-12-29" });
      const { job } = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
        actorUserId: USER_A,
        reviewId,
      });
      s.jobRepository.seed({ ...stored(s, job.id), status: "running" }, s.clock());
      return job.id;
    })();

    const response = await handleAiJobMessages(s.processDeps(), {
      Records: [
        { messageId: "m-ok", body: body(first.jobId) },
        { messageId: "m-not-json", body: "{" },
        { messageId: "m-bad-schema", body: JSON.stringify({ v: 1 }) },
        {
          messageId: "m-extra-key",
          body: JSON.stringify({ v: 1, jobId: first.jobId, input: "x" }),
        },
        { messageId: "m-missing-job", body: body("20000000-0000-4000-8000-ffffffffffff") },
        { messageId: "m-in-progress", body: body(inProgress) },
      ],
    });

    expect(response.batchItemFailures.map((item) => item.itemIdentifier)).toEqual([
      "m-not-json",
      "m-bad-schema",
      "m-extra-key",
      "m-in-progress",
    ]);
    expect(stored(s, first.jobId).status).toBe("succeeded");
  });

  it("同じ job の message が batch 内に 2 件あっても provider は 1 回", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const { jobId } = await queuedJob(s);
    const response = await handleAiJobMessages(s.processDeps(), {
      Records: [
        { messageId: "a", body: body(jobId) },
        { messageId: "b", body: body(jobId) },
      ],
    });
    expect(response.batchItemFailures).toEqual([]);
    expect(coach.calls).toHaveLength(1);
  });

  it("ApproximateReceiveCount を受信回数として使う(上限なら exhausted で ack、欠落・不正は 1 として retry)", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId } = await queuedJob(s);

    s.jobRepository.failNext("complete");
    const exhausted = await handleAiJobMessages(s.processDeps(), {
      Records: [
        {
          messageId: "x",
          body: body(jobId),
          attributes: { ApproximateReceiveCount: String(AI_JOB_MAX_RECEIVE) },
        },
      ],
    });
    expect(exhausted.batchItemFailures).toEqual([]);
    expect(stored(s, jobId).status).toBe("fallback");

    const t = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const second = await queuedJob(t);
    for (const attributes of [
      undefined,
      {},
      { ApproximateReceiveCount: "abc" },
      { ApproximateReceiveCount: "0" },
    ]) {
      t.jobRepository.failNext("complete");
      const response = await handleAiJobMessages(t.processDeps(), {
        Records: [{ messageId: "y", body: body(second.jobId), attributes }],
      });
      expect(response.batchItemFailures).toEqual([{ itemIdentifier: "y" }]);
    }
  });

  it("空の batch は何もしない", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    expect(await handleAiJobMessages(s.processDeps(), { Records: [] })).toEqual({
      batchItemFailures: [],
    });
  });

  it("queue 経由の一連の流れ: 依頼 → message → handler → succeeded", async () => {
    const s = setupAiJobTest(createScriptedCoach([completed(validPlan())]));
    const { jobId } = await queuedJob(s);
    const [message] = s.queue.messages;
    expect(message).toEqual({ v: 1, jobId });
    const response = await handleAiJobMessages(s.processDeps(), {
      Records: [{ messageId: "m1", body: JSON.stringify(message) }],
    });
    expect(response.batchItemFailures).toEqual([]);
    const job = await getAiJobUseCase(
      { jobRepository: s.jobRepository },
      { actorUserId: USER_A, jobId },
    );
    expect(job.status).toBe("succeeded");
  });
});
