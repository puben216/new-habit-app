import { randomUUID } from "node:crypto";
import {
  downloadDataExportUseCase,
  handleDataExportMessages,
  listDataExportsUseCase,
  requestDataExportUseCase,
} from "@habit-app/application";
import type { Clock, DataExportQueuePort } from "@habit-app/application";
import {
  createDataExportProcessDeps,
  createInlineDataExportQueue,
  createIpHasher,
  createPrismaAccountRepository,
  createPrismaLoginAttemptRepository,
} from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createDataExportHandlers } from "./data-export-handlers";
import type { DataExportHandlers } from "./data-export-handlers";
import { getServerEnv } from "./env";
import { actorUserIdFromSession } from "./session-actor";

/**
 * `/api/v1/me/exports*` の composition root(T-404 PR-B)。他の container と同様、初回リクエスト時まで構築を
 * 遅延させる(`next build` が env 検証や DB 接続を実行しないようにするため)。
 * `AUDIT_IP_HASH_KEY` が未設定でも動作する(監査の IP は固定値 `none` になる)。
 */
async function buildDataExportHandlers(): Promise<DataExportHandlers> {
  const env = getServerEnv();
  const { auth, prisma, passwordHasher } = await getAuthContainer();

  const processDeps = createDataExportProcessDeps(prisma);

  let queue: DataExportQueuePort;
  switch (env.EXPORT_QUEUE_DRIVER) {
    case "inline":
      // ローカル/E2E 用: 同一プロセスで worker と同じ handler を呼ぶ。本番では env の検証で拒否される。
      queue = createInlineDataExportQueue(async (message, receiveCount) => {
        const { batchItemFailures } = await handleDataExportMessages(processDeps, {
          Records: [
            {
              messageId: message.exportId,
              body: JSON.stringify(message),
              attributes: { ApproximateReceiveCount: String(receiveCount) },
            },
          ],
        });
        return batchItemFailures.length === 0 ? "done" : "retry";
      });
      break;
    case "sqs":
      // 実 SQS adapter は T-501 で実装する(AWS SDK・infra と合わせる)。
      throw new Error("EXPORT_QUEUE_DRIVER=sqs is not implemented yet");
    default: {
      const exhaustive: never = env.EXPORT_QUEUE_DRIVER;
      throw new Error(`unsupported EXPORT_QUEUE_DRIVER: ${String(exhaustive)}`);
    }
  }

  const now: Clock = () => new Date();
  const requestDeps = {
    accounts: createPrismaAccountRepository(prisma),
    exports: processDeps.exports,
    queue,
    passwordHasher,
    attempts: createPrismaLoginAttemptRepository(prisma),
    now,
  };
  const hashIp =
    env.AUDIT_IP_HASH_KEY === undefined
      ? (): string => "none"
      : createIpHasher(env.AUDIT_IP_HASH_KEY);

  return createDataExportHandlers({
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    // 認証(誰か)のみをここで判定する。認可(自分の分のみ)は repository の query 条件で行う。
    resolveActorUserId: async () => actorUserIdFromSession(await auth()),
    hashIp,
    newRequestId: randomUUID,
    useCases: {
      request: (input) => requestDataExportUseCase(requestDeps, input),
      list: (input) => listDataExportsUseCase({ exports: processDeps.exports, now }, input),
      download: (input) => downloadDataExportUseCase({ exports: processDeps.exports, now }, input),
    },
  });
}

let handlersPromise: Promise<DataExportHandlers> | undefined;

export function getDataExportHandlers(): Promise<DataExportHandlers> {
  handlersPromise ??= buildDataExportHandlers();
  return handlersPromise;
}
