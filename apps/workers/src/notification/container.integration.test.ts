import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "@habit-app/infrastructure/worker";
import type { PrismaClient } from "@habit-app/infrastructure/worker";
import { startFakeHttpServer, startPostgresContainer } from "@habit-app/test-support";
import type { FakeHttpServer, RecordedRequest } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDelivery, getFeedback, getScheduler } from "./container";
import type { SqsEvent } from "./handlers";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Lambda の composition root を、実 PostgreSQL と fake の SES/SQS(HTTP)で通す結合テスト。
 * AWS SDK の endpoint は `AWS_ENDPOINT_URL` で fake server に向ける(コードに分岐を持たない)。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../../../packages/infrastructure");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");

describe("通知 Lambda の composition root(結合)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let fake: FakeHttpServer;
  let userId: bigint;
  let env: Record<string, string>;

  const sqsBodies: string[] = [];
  const sesRequests: RecordedRequest[] = [];

  beforeAll(async () => {
    container = await startPostgresContainer();
    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });
    prisma = createPrismaClient(container.getConnectionUri());

    fake = await startFakeHttpServer((request) => {
      if (request.url === "/v2/email/outbound-emails") {
        sesRequests.push(request);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ MessageId: "ses-container-1" }),
        };
      }
      // SQS SendMessageBatch(SDK が MD5 を検証するため計算して返す)。
      const entries = (
        JSON.parse(request.body) as { Entries: { Id: string; MessageBody: string }[] }
      ).Entries;
      for (const entry of entries) sqsBodies.push(entry.MessageBody);
      return {
        status: 200,
        headers: { "content-type": "application/x-amz-json-1.0" },
        body: JSON.stringify({
          Successful: entries.map((e) => ({
            Id: e.Id,
            MessageId: `m-${e.Id}`,
            MD5OfMessageBody: createHash("md5").update(e.MessageBody).digest("hex"),
          })),
          Failed: [],
        }),
      };
    });

    process.env["AWS_ENDPOINT_URL"] = fake.endpoint;
    process.env["AWS_ACCESS_KEY_ID"] = "AKIAFAKEFAKEFAKEFAKE";
    process.env["AWS_SECRET_ACCESS_KEY"] = "fake".repeat(10);

    env = {
      NOTIFICATION_DELIVERY_ENABLED: "true",
      AWS_REGION: "ap-northeast-1",
      DATABASE_URL: container.getConnectionUri(),
      UNSUBSCRIBE_SIGNING_KEY: "s".repeat(40),
      APP_BASE_URL: "https://app.example.test",
      EMAIL_FROM: "no-reply@habit-app.example.test",
      SES_CONFIGURATION_SET: "habit-app-config",
      // SQS の SDK は QueueUrl のホストへ送るため、fake server を指す URL にする。
      NOTIFICATION_QUEUE_URL: `${fake.endpoint}/123456789012/notifications`,
    };

    // 検証済みユーザー、今この分に送信枠がある有効な設定(UTC、quiet hours なし)、今日予定された未記録の習慣。
    const user = await prisma.user.create({
      data: {
        authSubject: "credentials:container@example.com",
        emailNormalized: "container@example.com",
        passwordHash: "hash",
        emailVerifiedAt: new Date(),
      },
    });
    userId = user.id;
    const nowHhmm = new Date().toISOString().slice(11, 16);
    await prisma.$executeRaw`
      INSERT INTO notification_settings (user_id, local_time, timezone, enabled)
      VALUES (${userId}, ${nowHhmm}::time, 'UTC', true)`;
    await prisma.habit.create({
      data: {
        userId,
        kind: "build",
        name: "水を飲む",
        purpose: "テスト",
        cue: "テスト",
        minimumAction: "テスト",
        status: "active",
        scheduleVersions: {
          create: {
            effectiveFrom: new Date("2025-01-01T00:00:00Z"),
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            targetCount: 1,
          },
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    delete process.env["AWS_ENDPOINT_URL"];
    await prisma.$disconnect();
    await fake.close();
    await container.stop();
  }, 60_000);

  it("scheduler → delivery → feedback が実 DB と fake の SES/SQS で通り、重複しない", async () => {
    // 1. scheduler: 配送を作り、deliveryId のみの message を SQS へ投入する。
    const scheduler = await getScheduler(env);
    const summary = (await scheduler()) as { created: number; enqueued: number };
    expect(summary).toMatchObject({ created: 1, enqueued: 1 });
    expect(sqsBodies).toHaveLength(1);
    const message = JSON.parse(sqsBodies[0] ?? "{}") as { version: number; deliveryId: string };
    expect(Object.keys(message).sort()).toEqual(["deliveryId", "version"]);

    // 2. delivery: message を処理して SES で 1 通送る。同じ message をもう一度処理しても送らない。
    const delivery = await getDelivery(env);
    const event: SqsEvent = { Records: [{ messageId: "m1", body: sqsBodies[0] ?? "" }] };
    expect(await delivery(event)).toEqual({ batchItemFailures: [] });
    expect(await delivery(event)).toEqual({ batchItemFailures: [] });
    expect(sesRequests).toHaveLength(1);

    const ses = JSON.parse(sesRequests[0]?.body ?? "{}") as {
      Destination: { ToAddresses: string[] };
      ConfigurationSetName: string;
      Content: { Simple: { Headers: { Name: string; Value: string }[] } };
    };
    expect(ses.Destination.ToAddresses).toEqual(["container@example.com"]);
    expect(ses.ConfigurationSetName).toBe("habit-app-config");
    const unsubscribe = ses.Content.Simple.Headers.find((h) => h.Name === "List-Unsubscribe");
    expect(unsubscribe?.Value).toMatch(
      /^<https:\/\/app\.example\.test\/api\/v1\/notification-unsubscribe\?token=v1\./,
    );
    const rows = await prisma.notificationDelivery.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", providerMessageId: "ses-container-1" });

    // 3. scheduler を再実行しても配送は増えず、再投入もされない(投入済み・終端)。
    const again = (await scheduler()) as { created: number; enqueued: number };
    expect(again).toMatchObject({ created: 0, enqueued: 0 });

    // 4. feedback: Permanent bounce で suppression に記録される(同じ通知を再度受けても 1 件)。
    const feedback = await getFeedback(env);
    const bounce = {
      Message: JSON.stringify({
        eventType: "Bounce",
        mail: { messageId: "ses-container-1" },
        bounce: { bounceType: "Permanent" },
      }),
    };
    const feedbackEvent: SqsEvent = {
      Records: [{ messageId: "f1", body: JSON.stringify(bounce) }],
    };
    expect(await feedback(feedbackEvent)).toEqual({ batchItemFailures: [] });
    expect(await feedback(feedbackEvent)).toEqual({ batchItemFailures: [] });
    expect(await prisma.emailSuppression.count({ where: { userId } })).toBe(1);
  });

  it("Feature Flag が無効なら scheduler/delivery は DB・AWS に接続せず何もしない(環境変数の検証もしない)", async () => {
    // 別の module 状態で確認するため、キャッシュ済みの handler ではなく無効 env で新規に組み立てる。
    const { vi } = await import("vitest");
    vi.resetModules();
    const fresh = await import("./container");
    const scheduler = await fresh.getScheduler({ NOTIFICATION_DELIVERY_ENABLED: "false" });
    expect(await scheduler()).toEqual({ disabled: true });
    const delivery = await fresh.getDelivery({});
    const before = sqsBodies.length + sesRequests.length;
    const response = await delivery({
      Records: [{ messageId: "x", body: JSON.stringify({ version: 1, deliveryId: "1" }) }],
    });
    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqsBodies.length + sesRequests.length).toBe(before);
  });
});
