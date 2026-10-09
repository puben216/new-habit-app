import { ReminderEmailError } from "@habit-app/application";
import { startFakeHttpServer } from "@habit-app/test-support";
import type { FakeHandler, FakeHttpServer } from "@habit-app/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { classifySesError, createSesClient, createSesReminderSender } from "./ses-reminder-sender";

const CREDENTIALS = { accessKeyId: "AKIAFAKEFAKEFAKEFAKE", secretAccessKey: "fake".repeat(10) };
const EMAIL = {
  to: "member@example.test",
  subject: "今日の習慣を記録しましょう",
  text: "本文\n配信を停止する: https://app.example.test/api/v1/notification-unsubscribe?token=t",
  unsubscribeUrl: "https://app.example.test/api/v1/notification-unsubscribe?token=t",
};

const json = (status: number, body: unknown, errorType?: string) => ({
  status,
  headers: {
    "content-type": "application/json",
    ...(errorType === undefined ? {} : { "x-amzn-errortype": errorType }),
  },
  body: JSON.stringify(body),
});

describe("SES adapter(fake HTTP server)", () => {
  let server: FakeHttpServer | undefined;

  async function setup(handler: FakeHandler, timeoutMs?: number) {
    server = await startFakeHttpServer(handler);
    const sender = createSesReminderSender({
      client: createSesClient({
        region: "ap-northeast-1",
        endpoint: server.endpoint,
        credentials: CREDENTIALS,
      }),
      from: "no-reply@habit-app.example.test",
      configurationSet: "habit-app-config",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { sender, server };
  }

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const failureOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ReminderEmailError) return error;
      throw error;
    }
    throw new Error("expected a ReminderEmailError");
  };

  it("成功: message ID を返し、宛先・定型本文・配信停止ヘッダー・configuration set を送る", async () => {
    const { sender, server } = await setup(() => json(200, { MessageId: "ses-msg-123" }));
    expect(await sender.send(EMAIL)).toEqual({ providerMessageId: "ses-msg-123" });

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/v2/email/outbound-emails");
    const body = JSON.parse(request?.body ?? "{}");
    expect(body.FromEmailAddress).toBe("no-reply@habit-app.example.test");
    expect(body.ConfigurationSetName).toBe("habit-app-config");
    expect(body.Destination).toEqual({ ToAddresses: ["member@example.test"] });
    expect(body.Content.Simple.Subject.Data).toBe(EMAIL.subject);
    expect(body.Content.Simple.Body.Text.Data).toBe(EMAIL.text);
    expect(body.Content.Simple.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: `<${EMAIL.unsubscribeUrl}>` },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });

  it("429 TooManyRequestsException は transient(throttled)。SDK は再試行せず 1 回だけ呼ぶ", async () => {
    const { sender, server } = await setup(() =>
      json(429, { message: "Too many requests" }, "TooManyRequestsException"),
    );
    const error = await failureOf(sender.send(EMAIL));
    expect(error).toMatchObject({ kind: "transient", code: "throttled" });
    expect(server.requests).toHaveLength(1);
  });

  it("5xx は transient(server_error)で、SDK の再試行は行わない", async () => {
    for (const status of [500, 503]) {
      const { sender, server } = await setup(() => json(status, { message: "oops" }));
      const error = await failureOf(sender.send(EMAIL));
      expect(error).toMatchObject({ kind: "transient", code: "server_error" });
      expect(server.requests).toHaveLength(1);
      await server.close();
    }
  });

  it("MessageRejected / BadRequest / 認可エラーなどの 4xx は permanent", async () => {
    const cases: [number, string, string][] = [
      [400, "MessageRejected", "rejected"],
      [400, "MailFromDomainNotVerifiedException", "domain_not_verified"],
      [400, "BadRequestException", "bad_request"],
      [403, "AccessDeniedException", "client_error"],
    ];
    for (const [status, type, code] of cases) {
      const { sender, server } = await setup(() => json(status, { message: "no" }, type));
      expect(await failureOf(sender.send(EMAIL))).toMatchObject({ kind: "permanent", code });
      await server.close();
    }
  });

  it("応答しない場合は timeout で transient(timeout)になる", async () => {
    const { sender } = await setup(() => ({ hang: true }), 150);
    expect(await failureOf(sender.send(EMAIL))).toMatchObject({
      kind: "transient",
      code: "timeout",
    });
  });

  it("接続が切れた場合は transient(network_error)", async () => {
    const { sender } = await setup(() => ({ destroy: true }));
    const error = await failureOf(sender.send(EMAIL));
    expect(error.kind).toBe("transient");
  });

  it("message ID のない 200 は、再試行で重複送信にならないよう permanent(invalid_response)", async () => {
    const { sender } = await setup(() => json(200, {}));
    expect(await failureOf(sender.send(EMAIL))).toMatchObject({
      kind: "permanent",
      code: "invalid_response",
    });
  });

  it("失敗のメッセージ・コードに宛先・本文・応答本文を含めない", async () => {
    const { sender } = await setup(() =>
      json(
        400,
        { message: "Email address member@example.test is not verified" },
        "MessageRejected",
      ),
    );
    const error = await failureOf(sender.send(EMAIL));
    expect(`${error.message} ${error.code}`).not.toContain("member@example.test");
    expect(`${error.message} ${error.code}`).not.toContain("not verified");
  });
});

describe("classifySesError", () => {
  it.each<[string, unknown, string, string]>([
    ["AbortError", { name: "AbortError" }, "transient", "timeout"],
    ["TimeoutError", { name: "TimeoutError" }, "transient", "timeout"],
    ["LimitExceededException", { name: "LimitExceededException" }, "transient", "throttled"],
    ["status 429", { name: "X", $metadata: { httpStatusCode: 429 } }, "transient", "throttled"],
    ["status 502", { name: "X", $metadata: { httpStatusCode: 502 } }, "transient", "server_error"],
    ["status 404", { name: "X", $metadata: { httpStatusCode: 404 } }, "permanent", "client_error"],
    ["SendingPaused", { name: "SendingPausedException" }, "permanent", "sending_paused"],
    ["AccountSuspended", { name: "AccountSuspendedException" }, "permanent", "account_suspended"],
    ["情報なし", {}, "transient", "network_error"],
    ["Error 以外", "boom", "transient", "network_error"],
    ["null", null, "transient", "network_error"],
  ])("%s", (_label, input, kind, code) => {
    expect(classifySesError(input)).toMatchObject({ kind, code });
  });
});
