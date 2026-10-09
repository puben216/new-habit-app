import { describe, expect, it } from "vitest";

import {
  reminderQueueMessageSchema,
  sesFeedbackEventSchema,
  snsNotificationEnvelopeSchema,
  unsubscribeQuerySchema,
} from "./notification-delivery";

describe("unsubscribeQuerySchema", () => {
  it("token のみ受理し、空・長すぎる・未知キーを拒否する", () => {
    expect(unsubscribeQuerySchema.safeParse({ token: "v1.a.b" }).success).toBe(true);
    expect(unsubscribeQuerySchema.safeParse({ token: "" }).success).toBe(false);
    expect(unsubscribeQuerySchema.safeParse({ token: "a".repeat(513) }).success).toBe(false);
    expect(unsubscribeQuerySchema.safeParse({ token: "t", userId: "1" }).success).toBe(false);
    expect(unsubscribeQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe("reminderQueueMessageSchema", () => {
  it("version 1 と十進文字列の配送 ID のみ受理する", () => {
    expect(reminderQueueMessageSchema.safeParse({ version: 1, deliveryId: "42" }).success).toBe(
      true,
    );
    for (const bad of [
      { version: 2, deliveryId: "42" },
      { version: 1, deliveryId: "0" },
      { version: 1, deliveryId: "-1" },
      { version: 1, deliveryId: "abc" },
      { version: 1, deliveryId: 42 },
      { version: 1, deliveryId: "1".repeat(20) },
      { version: 1 },
      { version: 1, deliveryId: "42", email: "member@example.test" },
    ]) {
      expect(reminderQueueMessageSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("sesFeedbackEventSchema", () => {
  it("Bounce(bounceType つき)と Complaint を受理し、未知のキーは許容する", () => {
    const bounce = {
      eventType: "Bounce",
      mail: { messageId: "m-1", timestamp: "x", destination: ["a@example.test"] },
      bounce: { bounceType: "Permanent", bouncedRecipients: [] },
    };
    expect(sesFeedbackEventSchema.parse(bounce)).toMatchObject({ eventType: "Bounce" });
    expect(
      sesFeedbackEventSchema.safeParse({ eventType: "Complaint", mail: { messageId: "m-1" } })
        .success,
    ).toBe(true);
  });

  it("他の eventType・bounceType 欠落・messageId 欠落を拒否する", () => {
    expect(
      sesFeedbackEventSchema.safeParse({ eventType: "Delivery", mail: { messageId: "m" } }).success,
    ).toBe(false);
    expect(
      sesFeedbackEventSchema.safeParse({ eventType: "Bounce", mail: { messageId: "m" } }).success,
    ).toBe(false);
    expect(
      sesFeedbackEventSchema.safeParse({
        eventType: "Bounce",
        mail: {},
        bounce: { bounceType: "Permanent" },
      }).success,
    ).toBe(false);
    expect(
      sesFeedbackEventSchema.safeParse({
        eventType: "Bounce",
        mail: { messageId: "m" },
        bounce: { bounceType: "Other" },
      }).success,
    ).toBe(false);
  });
});

describe("snsNotificationEnvelopeSchema", () => {
  it("Message が文字列のものだけ受理する", () => {
    expect(
      snsNotificationEnvelopeSchema.safeParse({ Message: "{}", Type: "Notification" }).success,
    ).toBe(true);
    expect(snsNotificationEnvelopeSchema.safeParse({ Message: 1 }).success).toBe(false);
    expect(snsNotificationEnvelopeSchema.safeParse({}).success).toBe(false);
  });
});
