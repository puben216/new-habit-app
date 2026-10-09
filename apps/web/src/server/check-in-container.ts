import { getDailyCheckInUseCase, upsertDailyCheckInUseCase } from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { getServerEnv } from "./env";
import {
  createPrismaDailyCheckInRepository,
  createPrismaProfileRepository,
} from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createCheckInHandlers } from "./check-in-handlers";
import type { CheckInHandlers } from "./check-in-handlers";
import { actorUserIdFromSession } from "./session-actor";

/**
 * `/api/v1/daily-check-ins/{date}` の composition root(T-203)。他の container と同様、
 * 初回リクエスト時まで構築を遅延させる(`next build` が env 検証や DB 接続を実行しないようにするため)。
 */
async function buildCheckInHandlers(): Promise<CheckInHandlers> {
  const env = getServerEnv();
  const { auth, prisma } = await getAuthContainer();

  const checkInRepository = createPrismaDailyCheckInRepository(prisma);
  const profileRepository = createPrismaProfileRepository(prisma);
  const now: Clock = () => new Date();

  return createCheckInHandlers({
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    // 認証(誰か)のみをここで判定する。認可(自分の分のみ)は repository の query 条件で行う。
    resolveActorUserId: async () => actorUserIdFromSession(await auth()),
    useCases: {
      get: (input) => getDailyCheckInUseCase({ checkInRepository }, input),
      upsert: (input) =>
        upsertDailyCheckInUseCase({ checkInRepository, profileRepository, now }, input),
    },
  });
}

let handlersPromise: Promise<CheckInHandlers> | undefined;

export function getCheckInHandlers(): Promise<CheckInHandlers> {
  handlersPromise ??= buildCheckInHandlers();
  return handlersPromise;
}
