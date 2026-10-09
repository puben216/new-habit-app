import { describe, expect, it, vi } from "vitest";

import { memoizeAsync } from "./memoize";

describe("memoizeAsync", () => {
  it("成功した結果は保持し、factory は 1 回しか呼ばれない", async () => {
    const factory = vi.fn(async () => ({ id: 1 }));
    const get = memoizeAsync(factory);
    const first = await get();
    expect(await get()).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("同時に呼ばれても 1 回の初期化を共有する", async () => {
    const factory = vi.fn(async () => "value");
    const get = memoizeAsync(factory);
    expect(await Promise.all([get(), get(), get()])).toEqual(["value", "value", "value"]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("失敗はキャッシュせず、次の呼び出しで再試行して回復できる", async () => {
    let calls = 0;
    const get = memoizeAsync(async () => {
      calls += 1;
      if (calls === 1) throw new Error("secrets temporarily unavailable");
      return "recovered";
    });
    await expect(get()).rejects.toThrow("secrets temporarily unavailable");
    expect(await get()).toBe("recovered");
    expect(await get()).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("失敗が続く間は、呼ばれるたびに再試行する", async () => {
    const factory = vi.fn(async () => {
      throw new Error("down");
    });
    const get = memoizeAsync(factory);
    await expect(get()).rejects.toThrow("down");
    await expect(get()).rejects.toThrow("down");
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
