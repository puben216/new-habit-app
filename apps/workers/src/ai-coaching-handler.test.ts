import type { ProcessAiJobDeps } from "@habit-app/application";
import { describe, expect, it, vi } from "vitest";

import { createAiCoachingHandler } from "./ai-coaching-handler";

const JOB_ID = "20000000-0000-4000-8000-000000000001";

/** job が存在しない repository(claim は not_found)。handler が SQS event の形で動くことだけを検証する。 */
function depsWithMissingJobs(claim = vi.fn(async () => ({ status: "not_found" as const }))) {
  return {
    deps: { jobRepository: { claim } } as unknown as ProcessAiJobDeps,
    claim,
  };
}

describe("createAiCoachingHandler", () => {
  it("SQS event を処理し、ack できる record は batchItemFailures に含めない", async () => {
    const { deps, claim } = depsWithMissingJobs();
    const handler = createAiCoachingHandler(async () => deps);

    const response = await handler({
      Records: [{ messageId: "m1", body: JSON.stringify({ v: 1, jobId: JOB_ID }) }],
    });

    expect(response).toEqual({ batchItemFailures: [] });
    expect(claim).toHaveBeenCalledWith({ jobId: JOB_ID, leaseSeconds: 300 });
  });

  it("解釈できない message だけを失敗として返す(部分 batch 失敗)", async () => {
    const { deps } = depsWithMissingJobs();
    const handler = createAiCoachingHandler(async () => deps);

    const response = await handler({
      Records: [
        { messageId: "ok", body: JSON.stringify({ v: 1, jobId: JOB_ID }) },
        { messageId: "broken", body: "not json" },
        { messageId: "extra", body: JSON.stringify({ v: 1, jobId: JOB_ID, userId: "1" }) },
      ],
    });

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "broken" },
      { itemIdentifier: "extra" },
    ]);
  });

  it("依存は呼び出しごとに取得する(コールドスタート時の遅延構築)", async () => {
    const { deps } = depsWithMissingJobs();
    const getDeps = vi.fn(async () => deps);
    const handler = createAiCoachingHandler(getDeps);
    await handler({ Records: [] });
    await handler({ Records: [] });
    expect(getDeps).toHaveBeenCalledTimes(2);
  });
});
