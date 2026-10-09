import { startFakeHttpServer } from "@habit-app/test-support";
import type { FakeHandler, FakeHttpServer } from "@habit-app/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { createSecretsManagerClient, createSecretsReader } from "./secrets-reader";

const CREDENTIALS = { accessKeyId: "AKIAFAKEFAKEFAKEFAKE", secretAccessKey: "fake".repeat(10) };
const SECRET_ID = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:db-url-AbCdEf";

const ok = (value: string | undefined) => ({
  status: 200,
  headers: { "content-type": "application/x-amz-json-1.1" },
  body: JSON.stringify(value === undefined ? {} : { SecretString: value }),
});

describe("Secrets Manager reader(fake HTTP server)", () => {
  let server: FakeHttpServer | undefined;

  async function setup(handler: FakeHandler, timeoutMs?: number) {
    server = await startFakeHttpServer(handler);
    const reader = createSecretsReader({
      client: createSecretsManagerClient({
        region: "ap-northeast-1",
        endpoint: server.endpoint,
        credentials: CREDENTIALS,
      }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { reader, server };
  }

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("secret の文字列を返し、同じ ID は 1 回だけ読む(キャッシュ)", async () => {
    const { reader, server } = await setup(() => ok("postgresql://user:pw@db.example.test/app"));
    expect(await reader.getSecretString(SECRET_ID)).toBe(
      "postgresql://user:pw@db.example.test/app",
    );
    expect(await reader.getSecretString(SECRET_ID)).toBe(
      "postgresql://user:pw@db.example.test/app",
    );
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers["x-amz-target"]).toContain("GetSecretValue");
    expect(JSON.parse(server.requests[0]?.body ?? "{}")).toEqual({ SecretId: SECRET_ID });
  });

  it("同時の読み取りは 1 回の通信にまとまる", async () => {
    const { reader, server } = await setup(() => ok("value"));
    const values = await Promise.all([1, 2, 3].map(() => reader.getSecretString(SECRET_ID)));
    expect(values).toEqual(["value", "value", "value"]);
    expect(server.requests).toHaveLength(1);
  });

  it("失敗は汎用メッセージで投げ(ARN・値を含めない)、失敗はキャッシュせず次回再試行できる", async () => {
    let fail = true;
    const { reader } = await setup(() =>
      fail
        ? {
            status: 400,
            headers: {
              "content-type": "application/x-amz-json-1.1",
              "x-amzn-errortype": "ResourceNotFoundException",
            },
            body: JSON.stringify({ message: `Secrets Manager can't find ${SECRET_ID}` }),
          }
        : ok("recovered"),
    );
    const error = await reader.getSecretString(SECRET_ID).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toBe("failed to read secret");
    expect(error?.message).not.toContain(SECRET_ID);

    fail = false;
    expect(await reader.getSecretString(SECRET_ID)).toBe("recovered");
  });

  it("文字列の値がない(バイナリのみ)secret、応答しない場合はエラー", async () => {
    const empty = await setup(() => ok(undefined));
    await expect(empty.reader.getSecretString(SECRET_ID)).rejects.toThrow("no string value");
    await empty.server.close();

    const hanging = await setup(() => ({ hang: true }), 150);
    await expect(hanging.reader.getSecretString(SECRET_ID)).rejects.toThrow(
      "failed to read secret",
    );
  });
});
