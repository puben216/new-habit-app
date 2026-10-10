import { describe, expect, it } from "vitest";

import { archiveHabitUseCase } from "../habits/use-cases";
import { WeeklyReviewNotFoundError } from "../tracking/errors";
import { validPlan } from "./fixtures";
import {
  AiJobLimitReachedError,
  AiJobNotFoundError,
  AiQueueUnavailableError,
  AnalysisInputInvalidError,
  CorruptedAiJobError,
  WeeklyReviewNotCompletedError,
} from "./job-errors";
import { setupAiJobTest, USER_A, USER_B, WEEK } from "./job-test-setup";
import {
  AI_JOB_MAX_ACTIVE_PER_USER,
  getAiJobUseCase,
  requestWeeklyAnalysisUseCase,
} from "./job-use-cases";
import { completed, createScriptedCoach } from "./test-fakes";

function setup() {
  return setupAiJobTest(createScriptedCoach([completed(validPlan())]));
}

describe("requestWeeklyAnalysisUseCase", () => {
  it("確定済みレビューの job を queued で作成し、jobId だけの message を 1 件投入する", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A);

    const { job, created } = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });

    expect(created).toBe(true);
    expect(job).toMatchObject({
      kind: "weekly_improvement",
      status: "queued",
      subject: { type: "weekly_review", id: reviewId },
      promptVersion: "weekly-improvement/1",
      outputSchemaVersion: "1",
      result: null,
      failureCode: null,
    });
    expect(s.queue.messages).toEqual([{ v: 1, jobId: job.id }]);
    // 内部情報(user、provider、model、fingerprint)は API 用の job に含まれない
    expect(Object.keys(job).sort()).toEqual(
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
  });

  it("provider は依頼の時点では呼ばれない(非同期)", async () => {
    const coach = createScriptedCoach([completed(validPlan())]);
    const s = setupAiJobTest(coach);
    const reviewId = await s.createReview(USER_A);
    await requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_A, reviewId });
    expect(coach.calls).toHaveLength(0);
  });

  it("同じ入力の再依頼は同じ job を返し(created=false)、queued なら再投入する", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A);
    const first = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });
    const second = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(s.jobRepository.jobs.size).toBe(1);
    expect(s.queue.messages).toEqual([
      { v: 1, jobId: first.job.id },
      { v: 1, jobId: first.job.id },
    ]);
  });

  it("終端状態の既存 job は再投入せずそのまま返す", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A);
    const first = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });
    const stored = s.jobRepository.jobs.get(first.job.id);
    if (stored === undefined) throw new Error("job missing");
    s.jobRepository.seed({ ...stored, status: "failed", failureCode: "invalid_input" });

    const again = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });
    expect(again.created).toBe(false);
    expect(again.job.status).toBe("failed");
    expect(s.queue.messages).toHaveLength(1);
  });

  it("draft のレビューは WeeklyReviewNotCompletedError で job を作らない", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A, { complete: false });
    await expect(
      requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_A, reviewId }),
    ).rejects.toBeInstanceOf(WeeklyReviewNotCompletedError);
    expect(s.jobRepository.jobs.size).toBe(0);
    expect(s.queue.messages).toHaveLength(0);
  });

  it("他人のレビュー・存在しないレビューは WeeklyReviewNotFoundError", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A);
    await expect(
      requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_B, reviewId }),
    ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
    await expect(
      requestWeeklyAnalysisUseCase(s.requestDeps(), {
        actorUserId: USER_A,
        reviewId: "10000000-0000-4000-8000-ffffffffffff",
      }),
    ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
    expect(s.jobRepository.jobs.size).toBe(0);
  });

  it("入力を組み立てられない(制御文字を含む振り返り)なら AnalysisInputInvalidError", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A, { reflection: "a\u0000b" });
    await expect(
      requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_A, reviewId }),
    ).rejects.toBeInstanceOf(AnalysisInputInvalidError);
    expect(s.jobRepository.jobs.size).toBe(0);
  });

  it(`同時実行中の job が ${AI_JOB_MAX_ACTIVE_PER_USER} 件なら新規は AiJobLimitReachedError、既存の再取得は可能`, async () => {
    const s = setup();
    const weeks = ["2025-12-15", "2025-12-22", "2025-12-29"];
    const ids: string[] = [];
    for (const weekStart of weeks) {
      const reviewId = await s.createReview(USER_A, { weekStart });
      await requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_A, reviewId });
      ids.push(reviewId);
    }
    const another = await s.createReview(USER_A, { weekStart: WEEK });
    await expect(
      requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_A, reviewId: another }),
    ).rejects.toBeInstanceOf(AiJobLimitReachedError);
    expect(s.jobRepository.jobs.size).toBe(AI_JOB_MAX_ACTIVE_PER_USER);

    const existing = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId: ids[0] ?? "",
    });
    expect(existing.created).toBe(false);

    // 他ユーザーの job は上限に数えない
    const otherReview = await s.createReview(USER_B);
    await expect(
      requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_B, reviewId: otherReview }),
    ).resolves.toMatchObject({ created: true });
  });

  it("queue への投入に失敗したら AiQueueUnavailableError。job は queued で残り、再依頼で再投入される", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A);
    s.queue.failNext();
    await expect(
      requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_A, reviewId }),
    ).rejects.toBeInstanceOf(AiQueueUnavailableError);
    expect([...s.jobRepository.jobs.values()].map((job) => job.status)).toEqual(["queued"]);
    expect(s.queue.messages).toHaveLength(0);

    const retry = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });
    expect(retry.created).toBe(false);
    expect(s.queue.messages).toEqual([{ v: 1, jobId: retry.job.id }]);
  });

  it("入力が変われば(習慣のアーカイブで cue が変わる)別の job になる", async () => {
    const s = setup();
    const habitId = await s.createHabit(USER_A, "水を飲む");
    const reviewId = await s.createReview(USER_A);
    const first = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });

    await archiveHabitUseCase(
      { habitRepository: s.habitRepository, now: s.clock },
      { actorUserId: USER_A, habitId, version: 1 },
    );
    const second = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it("actor がすべての repository 呼び出しに渡る", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A);
    await requestWeeklyAnalysisUseCase(s.requestDeps(), { actorUserId: USER_A, reviewId });
    const actors = s.jobRepository.calls.map((call) => call.actorUserId);
    expect(actors.every((actor) => actor === USER_A)).toBe(true);
  });
});

describe("getAiJobUseCase", () => {
  it("自分の job を返し、他人の job・存在しない job は AiJobNotFoundError", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A);
    const { job } = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });
    const deps = { jobRepository: s.jobRepository };

    await expect(
      getAiJobUseCase(deps, { actorUserId: USER_A, jobId: job.id }),
    ).resolves.toMatchObject({ id: job.id });
    await expect(
      getAiJobUseCase(deps, { actorUserId: USER_B, jobId: job.id }),
    ).rejects.toBeInstanceOf(AiJobNotFoundError);
    await expect(
      getAiJobUseCase(deps, { actorUserId: USER_A, jobId: "20000000-0000-4000-8000-ffffffffffff" }),
    ).rejects.toBeInstanceOf(AiJobNotFoundError);
  });

  it("保存済みの結果が schema に合わなければ CorruptedAiJobError(内容を含めない)", async () => {
    const s = setup();
    const reviewId = await s.createReview(USER_A);
    const { job } = await requestWeeklyAnalysisUseCase(s.requestDeps(), {
      actorUserId: USER_A,
      reviewId,
    });
    const stored = s.jobRepository.jobs.get(job.id);
    if (stored === undefined) throw new Error("job missing");
    s.jobRepository.seed({
      ...stored,
      status: "succeeded",
      result: { schemaVersion: 2, secret: "x" },
    });

    const error = await getAiJobUseCase(
      { jobRepository: s.jobRepository },
      { actorUserId: USER_A, jobId: job.id },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorruptedAiJobError);
    expect((error as Error).message).not.toContain("secret");
  });
});
