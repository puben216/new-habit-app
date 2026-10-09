import { describe, expect, it } from "vitest";

import { createFakeDeliveryRepository, createFakeSuppressions } from "./delivery-test-fakes";
import { handleEmailFeedbackUseCase } from "./email-feedback";

const SETTING = { settingId: "10", userId: "1", localTime: "08:00", timezone: "Asia/Tokyo" };

function setup() {
  const deliveryRepository = createFakeDeliveryRepository();
  deliveryRepository.seedPending({
    id: "100",
    setting: SETTING,
    scheduledAt: new Date("2026-01-14T23:00:00Z"),
    status: "sent",
    providerMessageId: "ses-msg-1",
  });
  const suppressions = createFakeSuppressions();
  const deps = { deliveryRepository, suppressions, now: () => new Date("2026-01-15T00:00:00Z") };
  return { deps, suppressions };
}

describe("handleEmailFeedbackUseCase", () => {
  it("Permanent bounce は suppression(bounce)。同じ通知を再度受けても 1 件のまま", async () => {
    const { deps, suppressions } = setup();
    const event = { kind: "bounce_permanent", providerMessageId: "ses-msg-1" } as const;
    expect(await handleEmailFeedbackUseCase(deps, event)).toBe("suppressed");
    expect(await handleEmailFeedbackUseCase(deps, event)).toBe("suppressed");
    expect([...suppressions.users.entries()]).toEqual([["1", "bounce"]]);
  });

  it("Complaint は suppression(complaint)", async () => {
    const { deps, suppressions } = setup();
    await handleEmailFeedbackUseCase(deps, { kind: "complaint", providerMessageId: "ses-msg-1" });
    expect(suppressions.users.get("1")).toBe("complaint");
  });

  it("Transient bounce は suppression しない", async () => {
    const { deps, suppressions } = setup();
    expect(
      await handleEmailFeedbackUseCase(deps, {
        kind: "bounce_transient",
        providerMessageId: "ses-msg-1",
      }),
    ).toBe("ignored");
    expect(suppressions.users.size).toBe(0);
  });

  it("未知の message ID は無視する", async () => {
    const { deps, suppressions } = setup();
    expect(
      await handleEmailFeedbackUseCase(deps, { kind: "complaint", providerMessageId: "unknown" }),
    ).toBe("ignored");
    expect(suppressions.users.size).toBe(0);
  });
});
