import { unsubscribeUseCase } from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { parseEnv } from "@habit-app/config";
import {
  createHmacUnsubscribeTokenSigner,
  createPrismaNotificationSettingsRepository,
} from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createUnsubscribeHandlers } from "./unsubscribe-handlers";
import type { UnsubscribeHandlers } from "./unsubscribe-handlers";

/**
 * `/api/v1/notification-unsubscribe` の composition root(T-402)。他の container と同様、
 * 初回リクエスト時まで構築を遅延させる(`next build` が env 検証や DB 接続を実行しないようにするため)。
 * 署名鍵が未設定なら構築に失敗し、endpoint は 500 を返す(鍵なしで token を受理しない)。
 */
async function buildUnsubscribeHandlers(): Promise<UnsubscribeHandlers> {
  const env = parseEnv(process.env);
  if (env.UNSUBSCRIBE_SIGNING_KEY === undefined) {
    throw new Error("UNSUBSCRIBE_SIGNING_KEY is required for the unsubscribe endpoint");
  }
  const { prisma } = await getAuthContainer();

  const unsubscribeTokens = createHmacUnsubscribeTokenSigner(env.UNSUBSCRIBE_SIGNING_KEY);
  const settingsRepository = createPrismaNotificationSettingsRepository(prisma);
  const now: Clock = () => new Date();

  return createUnsubscribeHandlers({
    isValidToken: (token) => unsubscribeTokens.verify(token) !== null,
    unsubscribe: (token) =>
      unsubscribeUseCase({ unsubscribeTokens, settingsRepository, now }, { token }),
  });
}

let handlersPromise: Promise<UnsubscribeHandlers> | undefined;

export function getUnsubscribeHandlers(): Promise<UnsubscribeHandlers> {
  handlersPromise ??= buildUnsubscribeHandlers();
  return handlersPromise;
}
