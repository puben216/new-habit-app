import { describe, expect, it, vi } from "vitest";

import { createCleanupHandler, createProcessHandler } from "./handlers";
import type { LogCounts } from "./handlers";

function logger() {
  const logs: { event: string; counts: LogCounts }[] = [];
  return { logs, log: (event: string, counts: LogCounts) => logs.push({ event, counts }) };
}
const batch = {
  Records: [
    { messageId: "m1", body: "{}" },
    { messageId: "m2", body: "{}" },
  ],
};

describe("createProcessHandler", () => {
  it("有効なら batch を処理し、件数だけをログに出す(message の内容は出さない)", async () => {
    const { logs, log } = logger();
    const handle = vi.fn(async () => ({ batchItemFailures: [{ itemIdentifier: "m2" }] }));
    const result = await createProcessHandler({ enabled: true, handle, log })(batch);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    expect(logs).toEqual([{ event: "export.process", counts: { received: 2, failed: 1 } }]);
  });

  it("無効なら処理せず(DB に触れず)、全 message を失敗として返して queue に残す", async () => {
    const { logs, log } = logger();
    const handle = vi.fn(async () => ({ batchItemFailures: [] }));
    const result = await createProcessHandler({ enabled: false, handle, log })(batch);
    expect(handle).not.toHaveBeenCalled();
    expect(result.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(["m1", "m2"]);
    expect(logs).toEqual([{ event: "export.process", counts: { disabled: true, received: 2 } }]);
  });

  it("処理の例外は伝播し、ログに内容を出さない", async () => {
    const { logs, log } = logger();
    const handler = createProcessHandler({
      enabled: true,
      handle: async () => {
        throw new Error("password=secret host=db.internal");
      },
      log,
    });
    await expect(handler(batch)).rejects.toThrow();
    expect(JSON.stringify(logs)).not.toMatch(/secret|db\.internal/);
  });
});

describe("createCleanupHandler", () => {
  const summary = { expired: 3, staleFailed: 2, deleted: 1 };

  it("有効なら use case を実行し、件数だけをログに出す", async () => {
    const { logs, log } = logger();
    const run = vi.fn(async () => summary);
    await expect(createCleanupHandler({ enabled: true, run, log })()).resolves.toEqual(summary);
    expect(logs).toEqual([{ event: "export.cleanup", counts: summary }]);
  });

  it("Feature Flag が無効なら use case を呼ばない", async () => {
    const { logs, log } = logger();
    const run = vi.fn(async () => summary);
    await expect(createCleanupHandler({ enabled: false, run, log })()).resolves.toEqual({
      disabled: true,
    });
    expect(run).not.toHaveBeenCalled();
    expect(logs).toEqual([{ event: "export.cleanup", counts: { disabled: true } }]);
  });

  it("ログのキーは件数のみ", async () => {
    const { logs, log } = logger();
    await createCleanupHandler({ enabled: true, run: async () => summary, log })();
    expect(Object.keys(logs[0]?.counts ?? {}).sort()).toEqual([
      "deleted",
      "expired",
      "staleFailed",
    ]);
  });
});
