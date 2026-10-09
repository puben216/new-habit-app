import { describe, expect, it, vi } from "vitest";

import {
  createDeliveryHandler,
  createFeedbackHandler,
  createSchedulerHandler,
  parseFeedback,
} from "./handlers";
import type { LogCounts, SqsEvent } from "./handlers";

const record = (messageId: string, body: unknown) => ({
  messageId,
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const event = (...records: ReturnType<typeof record>[]): SqsEvent => ({ Records: records });
const message = (deliveryId: string) => ({ version: 1, deliveryId });

function logger() {
  const logs: { event: string; counts: LogCounts }[] = [];
  return { logs, log: (e: string, counts: LogCounts) => logs.push({ event: e, counts }) };
}

describe("createSchedulerHandler", () => {
  const summary = {
    scanned: 3,
    created: 2,
    invalidSettings: 0,
    exhausted: 0,
    enqueued: 2,
    enqueueFailed: 0,
  };

  it("有効なら use case を実行し、件数だけをログに出す", async () => {
    const { logs, log } = logger();
    const run = vi.fn(async () => summary);
    const result = await createSchedulerHandler({ enabled: true, run, log })();
    expect(result).toEqual(summary);
    expect(run).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ event: "notification.scheduler", counts: summary }]);
  });

  it("Feature Flag が無効なら何も実行しない", async () => {
    const { logs, log } = logger();
    const run = vi.fn(async () => summary);
    expect(await createSchedulerHandler({ enabled: false, run, log })()).toEqual({
      disabled: true,
    });
    expect(run).not.toHaveBeenCalled();
    expect(logs[0]?.counts).toEqual({ disabled: true });
  });

  it("use case の失敗は握りつぶさず投げる(Lambda の失敗として記録される)", async () => {
    const { log } = logger();
    const handler = createSchedulerHandler({
      enabled: true,
      run: async () => {
        throw new Error("db down");
      },
      log,
    });
    await expect(handler()).rejects.toThrow("db down");
  });
});

describe("createDeliveryHandler", () => {
  it("message ごとに配送を処理し、結果の件数をログに出す", async () => {
    const { logs, log } = logger();
    const deliver = vi.fn(async (id: string) =>
      id === "2" ? ("skipped" as const) : ("sent" as const),
    );
    const handler = createDeliveryHandler({ enabled: true, deliver, log });
    const response = await handler(
      event(record("m1", message("1")), record("m2", message("2")), record("m3", message("3"))),
    );
    expect(response).toEqual({ batchItemFailures: [] });
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(["1", "2", "3"]);
    expect(logs[0]?.counts).toMatchObject({
      received: 3,
      sent: 2,
      skipped: 1,
      discarded: 0,
      errors: 0,
    });
  });

  it("例外になった message だけを batchItemFailures で返し、他は処理を続ける", async () => {
    const { logs, log } = logger();
    const deliver = vi.fn(async (id: string) => {
      if (id === "2") throw new Error("connection refused member@example.test");
      return "sent" as const;
    });
    const handler = createDeliveryHandler({ enabled: true, deliver, log });
    const response = await handler(
      event(record("m1", message("1")), record("m2", message("2")), record("m3", message("3"))),
    );
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(logs[0]?.counts).toMatchObject({ sent: 2, errors: 1 });
    // 例外メッセージ(個人情報を含みうる)をログへ出さない。
    expect(JSON.stringify(logs)).not.toContain("member@example.test");
  });

  it("不正な message(JSON でない・schema 違反・個人情報つき)は破棄して成功扱い。deliver を呼ばない", async () => {
    const { logs, log } = logger();
    const deliver = vi.fn(async () => "sent" as const);
    const handler = createDeliveryHandler({ enabled: true, deliver, log });
    const response = await handler(
      event(
        record("a", "not json"),
        record("b", { version: 2, deliveryId: "1" }),
        record("c", { version: 1, deliveryId: "abc" }),
        record("d", { version: 1, deliveryId: "1", email: "member@example.test" }),
        record("e", "[]"),
      ),
    );
    expect(response).toEqual({ batchItemFailures: [] });
    expect(deliver).not.toHaveBeenCalled();
    expect(logs[0]?.counts).toMatchObject({ received: 5, discarded: 5 });
  });

  it("Feature Flag が無効の間は message を消費して何も配送しない", async () => {
    const { logs, log } = logger();
    const deliver = vi.fn(async () => "sent" as const);
    const response = await createDeliveryHandler({ enabled: false, deliver, log })(
      event(record("m1", message("1"))),
    );
    expect(response).toEqual({ batchItemFailures: [] });
    expect(deliver).not.toHaveBeenCalled();
    expect(logs[0]?.counts).toMatchObject({ disabled: true });
  });

  it("空の batch でも成功する", async () => {
    const { log } = logger();
    const response = await createDeliveryHandler({
      enabled: true,
      deliver: async () => "sent",
      log,
    })(event());
    expect(response).toEqual({ batchItemFailures: [] });
  });
});

const sns = (inner: unknown) => ({
  Type: "Notification",
  MessageId: "sns-1",
  Message: typeof inner === "string" ? inner : JSON.stringify(inner),
});
const bounce = (bounceType: string, messageId = "ses-1") => ({
  eventType: "Bounce",
  mail: { messageId },
  bounce: { bounceType },
});

describe("parseFeedback", () => {
  it("Permanent は bounce_permanent、Transient/Undetermined は bounce_transient、Complaint は complaint", () => {
    expect(parseFeedback(JSON.stringify(sns(bounce("Permanent"))))).toEqual({
      kind: "bounce_permanent",
      providerMessageId: "ses-1",
    });
    expect(parseFeedback(JSON.stringify(sns(bounce("Transient"))))).toMatchObject({
      kind: "bounce_transient",
    });
    expect(parseFeedback(JSON.stringify(sns(bounce("Undetermined"))))).toMatchObject({
      kind: "bounce_transient",
    });
    expect(
      parseFeedback(JSON.stringify(sns({ eventType: "Complaint", mail: { messageId: "ses-2" } }))),
    ).toEqual({ kind: "complaint", providerMessageId: "ses-2" });
  });

  it("対象外の eventType・不正な形式は null", () => {
    for (const body of [
      JSON.stringify(sns({ eventType: "Delivery", mail: { messageId: "x" } })),
      JSON.stringify(sns("not json")),
      JSON.stringify({ Message: 1 }),
      JSON.stringify(sns({ eventType: "Bounce", mail: {} })),
      "not json",
      "[]",
    ]) {
      expect(parseFeedback(body)).toBeNull();
    }
  });
});

describe("createFeedbackHandler", () => {
  it("bounce/complaint を use case に渡し、結果の件数をログに出す。対象外は破棄", async () => {
    const { logs, log } = logger();
    const handle = vi.fn(async (e: { kind: string }) =>
      e.kind === "bounce_transient" ? ("ignored" as const) : ("suppressed" as const),
    );
    const handler = createFeedbackHandler({ handle, log });
    const response = await handler(
      event(
        record("a", sns(bounce("Permanent", "m-a"))),
        record("b", sns(bounce("Transient", "m-b"))),
        record("c", sns({ eventType: "Delivery", mail: { messageId: "m-c" } })),
        record("d", "garbage"),
      ),
    );
    expect(response).toEqual({ batchItemFailures: [] });
    expect(handle).toHaveBeenCalledTimes(2);
    expect(logs[0]?.counts).toMatchObject({ received: 4, suppressed: 1, ignored: 1, discarded: 2 });
  });

  it("例外になった message だけを部分失敗として返す", async () => {
    const { log } = logger();
    const handle = vi.fn(async (e: { providerMessageId: string }) => {
      if (e.providerMessageId === "bad") throw new Error("db down");
      return "suppressed" as const;
    });
    const response = await createFeedbackHandler({ handle, log })(
      event(
        record("a", sns(bounce("Permanent", "ok"))),
        record("b", sns(bounce("Permanent", "bad"))),
      ),
    );
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "b" }] });
  });
});
