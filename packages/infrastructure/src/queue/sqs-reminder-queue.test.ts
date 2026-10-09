import { createHash } from "node:crypto";
import { startFakeHttpServer } from "@habit-app/test-support";
import type { FakeHandler, FakeHttpServer, RecordedRequest } from "@habit-app/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { createSqsClient, createSqsReminderQueue } from "./sqs-reminder-queue";

const CREDENTIALS = { accessKeyId: "AKIAFAKEFAKEFAKEFAKE", secretAccessKey: "fake".repeat(10) };
const QUEUE_URL = "https://sqs.ap-northeast-1.amazonaws.example.test/123456789012/notifications";

interface BatchEntry {
  Id: string;
  MessageBody: string;
}

const entriesOf = (request: RecordedRequest): BatchEntry[] =>
  (JSON.parse(request.body) as { Entries: BatchEntry[] }).Entries;

/** 全 entry を成功にする SendMessageBatch 応答(SDK が MD5 を検証するため計算して返す)。 */
function successFor(request: RecordedRequest, failIds: ReadonlySet<string> = new Set()) {
  const entries = entriesOf(request);
  return {
    status: 200,
    headers: { "content-type": "application/x-amz-json-1.0" },
    body: JSON.stringify({
      Successful: entries
        .filter((e) => !failIds.has(e.Id))
        .map((e) => ({
          Id: e.Id,
          MessageId: `m-${e.Id}`,
          MD5OfMessageBody: createHash("md5").update(e.MessageBody).digest("hex"),
        })),
      Failed: entries
        .filter((e) => failIds.has(e.Id))
        .map((e) => ({ Id: e.Id, SenderFault: false, Code: "InternalError" })),
    }),
  };
}

describe("SQS producer(fake HTTP server)", () => {
  let server: FakeHttpServer | undefined;

  async function setup(handler: FakeHandler, timeoutMs?: number) {
    server = await startFakeHttpServer(handler);
    const queue = createSqsReminderQueue({
      client: createSqsClient({
        region: "ap-northeast-1",
        endpoint: server.endpoint,
        credentials: CREDENTIALS,
      }),
      queueUrl: QUEUE_URL,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { queue, server };
  }

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("message は version と deliveryId のみ。投入に成功した ID を返す", async () => {
    const { queue, server } = await setup((request) => successFor(request));
    expect(await queue.enqueue(["11", "12"])).toEqual(["11", "12"]);

    const request = server.requests[0];
    expect(request?.headers["x-amz-target"]).toContain("SendMessageBatch");
    const parsed = JSON.parse(request?.body ?? "{}") as { QueueUrl: string };
    expect(parsed.QueueUrl).toBe(QUEUE_URL);
    expect(entriesOf(request as RecordedRequest).map((e) => JSON.parse(e.MessageBody))).toEqual([
      { version: 1, deliveryId: "11" },
      { version: 1, deliveryId: "12" },
    ]);
  });

  it("10 件ごとに分割して送る(25 件なら 3 回)", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(i + 1));
    const { queue, server } = await setup((request) => successFor(request));
    expect(await queue.enqueue(ids)).toEqual(ids);
    expect(server.requests.map((r) => entriesOf(r).length)).toEqual([10, 10, 5]);
  });

  it("入力が空なら通信しない", async () => {
    const { queue, server } = await setup((request) => successFor(request));
    expect(await queue.enqueue([])).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });

  it("一部の entry が失敗(Failed)したら、成功した ID だけを返す", async () => {
    const { queue } = await setup((request) => successFor(request, new Set(["1"])));
    expect(await queue.enqueue(["21", "22", "23"])).toEqual(["21", "23"]);
  });

  it("ある batch が 5xx で失敗しても、その batch だけが未投入になり、次の batch は試す。SDK は再試行しない", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const { queue, server } = await setup((request, index) =>
      index === 0
        ? { status: 500, headers: { "content-type": "application/x-amz-json-1.0" }, body: "{}" }
        : successFor(request),
    );
    expect(await queue.enqueue(ids)).toEqual(["11", "12"]);
    expect(server.requests).toHaveLength(2);
  });

  it("応答しない・接続が切れる場合は例外にせず、未投入として返す(timeout は明示)", async () => {
    const hanging = await setup(() => ({ hang: true }), 150);
    expect(await hanging.queue.enqueue(["1"])).toEqual([]);
    await hanging.server.close();

    const broken = await setup(() => ({ destroy: true }));
    expect(await broken.queue.enqueue(["1"])).toEqual([]);
  });
});
