import { AI_JOB_MAX_RECEIVE } from "@habit-app/application";
import type { ProcessAiJobOutcome } from "@habit-app/application";
import { describe, expect, it } from "vitest";

import { createInlineAiJobQueue } from "./inline-ai-job-queue";

const MESSAGE = { v: 1, jobId: "20000000-0000-4000-8000-000000000001" } as const;

describe("createInlineAiJobQueue", () => {
  it("enqueue は handler の完了を待たず、flush で完了を待てる", async () => {
    const calls: number[] = [];
    const queue = createInlineAiJobQueue(async (_message, receiveCount) => {
      calls.push(receiveCount);
      return "done";
    });

    await queue.enqueue(MESSAGE);
    expect(calls).toEqual([]);

    await queue.flush();
    expect(calls).toEqual([1]);
  });

  it(`retry が続く間は受信回数を 1 から増やし、ちょうど ${AI_JOB_MAX_RECEIVE} 回で打ち切る`, async () => {
    const calls: number[] = [];
    const queue = createInlineAiJobQueue(async (_message, receiveCount) => {
      calls.push(receiveCount);
      return "retry";
    });

    await queue.enqueue(MESSAGE);
    await queue.flush();

    expect(calls).toEqual(Array.from({ length: AI_JOB_MAX_RECEIVE }, (_, i) => i + 1));
  });

  it("done になった時点で再配送を止める", async () => {
    const outcomes: ProcessAiJobOutcome[] = ["retry", "done"];
    const calls: number[] = [];
    const queue = createInlineAiJobQueue(async (_message, receiveCount) => {
      calls.push(receiveCount);
      return outcomes[receiveCount - 1] ?? "retry";
    });

    await queue.enqueue(MESSAGE);
    await queue.flush();

    expect(calls).toEqual([1, 2]);
  });

  it("handler の例外は retry として扱い、flush は reject しない", async () => {
    let attempts = 0;
    const queue = createInlineAiJobQueue(async () => {
      attempts += 1;
      throw new Error("boom");
    });

    await queue.enqueue(MESSAGE);
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(attempts).toBe(AI_JOB_MAX_RECEIVE);
  });

  it("複数の message を独立に配送する", async () => {
    const seen: string[] = [];
    const queue = createInlineAiJobQueue(async (message) => {
      seen.push(message.jobId);
      return "done";
    });

    await queue.enqueue(MESSAGE);
    await queue.enqueue({ ...MESSAGE, jobId: "20000000-0000-4000-8000-000000000002" });
    await queue.flush();

    expect(seen.sort()).toEqual([
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ]);
  });
});
