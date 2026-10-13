import { describe, expect, it, vi } from "vitest";

import { createPurgeHandler } from "./handlers";
import type { LogCounts } from "./handlers";

function logger() {
  const logs: { event: string; counts: LogCounts }[] = [];
  return { logs, log: (event: string, counts: LogCounts) => logs.push({ event, counts }) };
}

const summary = { purged: 2, failed: 1, skipped: 0 };

describe("createPurgeHandler", () => {
  it("有効なら use case を実行し、件数だけをログに出す", async () => {
    const { logs, log } = logger();
    const run = vi.fn(async () => summary);
    await expect(createPurgeHandler({ enabled: true, run, log })()).resolves.toEqual(summary);
    expect(run).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ event: "account.purge", counts: summary }]);
  });

  it("Feature Flag が無効なら use case を呼ばず(DB に触れず)、無効であることだけをログに出す", async () => {
    const { logs, log } = logger();
    const run = vi.fn(async () => summary);
    await expect(createPurgeHandler({ enabled: false, run, log })()).resolves.toEqual({
      disabled: true,
    });
    expect(run).not.toHaveBeenCalled();
    expect(logs).toEqual([{ event: "account.purge", counts: { disabled: true } }]);
  });

  it("失敗したユーザーがいても例外にしない(失敗件数をログに残し、次回に再試行される)", async () => {
    const { logs, log } = logger();
    const handler = createPurgeHandler({
      enabled: true,
      run: async () => ({ purged: 0, failed: 3, skipped: 0 }),
      log,
    });
    await expect(handler()).resolves.toEqual({ purged: 0, failed: 3, skipped: 0 });
    expect(logs[0]?.counts).toMatchObject({ failed: 3 });
  });

  it("use case 自体の失敗(対象の取得に失敗など)は伝播し、ログに内容を出さない", async () => {
    const { logs, log } = logger();
    const handler = createPurgeHandler({
      enabled: true,
      run: async () => {
        throw new Error("password=secret host=db.internal");
      },
      log,
    });
    await expect(handler()).rejects.toThrow();
    expect(JSON.stringify(logs)).not.toMatch(/secret|db\.internal/);
  });

  it("ログに識別子やメールの形が現れない(件数のキーのみ)", async () => {
    const { logs, log } = logger();
    await createPurgeHandler({ enabled: true, run: async () => summary, log })();
    expect(Object.keys(logs[0]?.counts ?? {}).sort()).toEqual(["failed", "purged", "skipped"]);
  });
});
