import { describe, expect, it } from "vitest";

import { createFakeUnsubscribeTokens } from "./delivery-test-fakes";
import { createFakeNotificationSettingsRepository } from "./test-fakes";
import { unsubscribeUseCase } from "./unsubscribe";

const NOW = new Date("2026-01-15T00:00:00Z");
const enabled = {
  enabled: true,
  localTime: "08:00",
  timezone: "Asia/Tokyo",
  quietHours: null,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function setup() {
  const settingsRepository = createFakeNotificationSettingsRepository(["1", "2"], {
    "pub-1": "1",
    "pub-2": "2",
  });
  settingsRepository.seed("1", enabled);
  settingsRepository.seed("2", enabled);
  return {
    settingsRepository,
    deps: { unsubscribeTokens: createFakeUnsubscribeTokens(), settingsRepository, now: () => NOW },
  };
}

describe("unsubscribeUseCase", () => {
  it("有効な token で対象ユーザーだけを無効にし、他の項目は変えない。他ユーザーには影響しない", async () => {
    const { deps, settingsRepository } = setup();
    expect(await unsubscribeUseCase(deps, { token: "fake.pub-1" })).toBe("unsubscribed");
    expect(settingsRepository.records.get("1")).toMatchObject({
      enabled: false,
      localTime: "08:00",
      timezone: "Asia/Tokyo",
    });
    expect(settingsRepository.records.get("2")?.enabled).toBe(true);
  });

  it("2 回目も同じ結果(冪等)で、設定が無いユーザーでも成功する", async () => {
    const { deps, settingsRepository } = setup();
    await unsubscribeUseCase(deps, { token: "fake.pub-1" });
    const before = settingsRepository.records.get("1");
    expect(await unsubscribeUseCase(deps, { token: "fake.pub-1" })).toBe("unsubscribed");
    expect(settingsRepository.records.get("1")).toEqual(before);
    expect(await unsubscribeUseCase(deps, { token: "fake.unknown" })).toBe("unsubscribed");
  });

  it("不正な token は invalid_token で何も変更しない", async () => {
    const { deps, settingsRepository } = setup();
    expect(await unsubscribeUseCase(deps, { token: "garbage" })).toBe("invalid_token");
    expect(settingsRepository.calls.some((c) => c.method === "disableByUserPublicId")).toBe(false);
  });
});
