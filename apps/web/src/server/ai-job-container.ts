import {
  getAiJobUseCase,
  handleAiJobMessages,
  requestWeeklyAnalysisUseCase,
} from "@habit-app/application";
import { parseEnv } from "@habit-app/config";
import {
  aiJobConfigFor,
  createAiJobProcessDeps,
  createInlineAiJobQueue,
  createPrismaHabitRepository,
  createPrismaWeeklyReviewRepository,
} from "@habit-app/infrastructure";
import type { AiJobQueuePort } from "@habit-app/application";

import { getAuthContainer } from "./auth-container";
import { createAiJobHandlers } from "./ai-job-handlers";
import type { AiJobHandlers } from "./ai-job-handlers";
import { actorUserIdFromSession } from "./session-actor";

/**
 * `/api/v1/weekly-reviews/{id}/analysis` と `/api/v1/ai-jobs/{id}` の composition root(T-303)。
 * 他の container と同様、初回リクエスト時まで構築を遅延させる
 * (`next build` が env 検証や DB 接続を実行しないようにするため)。
 */
async function buildAiJobHandlers(): Promise<AiJobHandlers> {
  const env = parseEnv(process.env);
  const { auth, prisma } = await getAuthContainer();

  const wiring = {
    provider: env.AI_PROVIDER,
    publicationEnabled: env.AI_PUBLICATION_ENABLED,
  } as const;
  const processDeps = createAiJobProcessDeps(prisma, wiring);

  let queue: AiJobQueuePort;
  switch (env.AI_QUEUE_DRIVER) {
    case "inline":
      // ローカル/E2E 用: 同一プロセスで worker と同じ handler を呼ぶ。本番では env の検証で拒否される。
      queue = createInlineAiJobQueue(async (message, receiveCount) => {
        const { batchItemFailures } = await handleAiJobMessages(processDeps, {
          Records: [
            {
              messageId: message.jobId,
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
      throw new Error("AI_QUEUE_DRIVER=sqs is not implemented yet");
    default: {
      const exhaustive: never = env.AI_QUEUE_DRIVER;
      throw new Error(`unsupported AI_QUEUE_DRIVER: ${String(exhaustive)}`);
    }
  }

  const requestDeps = {
    reviewRepository: createPrismaWeeklyReviewRepository(prisma),
    habitRepository: createPrismaHabitRepository(prisma),
    jobRepository: processDeps.jobRepository,
    queue,
    config: aiJobConfigFor(env.AI_PROVIDER),
    now: processDeps.now,
  };

  return createAiJobHandlers({
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    // 認証(誰か)のみをここで判定する。認可(自分の分のみ)は repository の query 条件で行う。
    resolveActorUserId: async () => actorUserIdFromSession(await auth()),
    useCases: {
      requestAnalysis: (input) => requestWeeklyAnalysisUseCase(requestDeps, input),
      get: (input) => getAiJobUseCase({ jobRepository: processDeps.jobRepository }, input),
    },
  });
}

let handlersPromise: Promise<AiJobHandlers> | undefined;

export function getAiJobHandlers(): Promise<AiJobHandlers> {
  handlersPromise ??= buildAiJobHandlers();
  return handlersPromise;
}
