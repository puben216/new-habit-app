import {
  createWeeklyReviewUseCase,
  getWeeklyReviewUseCase,
  listWeeklyReviewsUseCase,
  updateWeeklyReviewUseCase,
} from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { parseEnv } from "@habit-app/config";
import {
  createPrismaDailyCheckInRepository,
  createPrismaHabitEntryRepository,
  createPrismaHabitRepository,
  createPrismaProfileRepository,
  createPrismaWeeklyReviewRepository,
} from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { actorUserIdFromSession } from "./session-actor";
import { createWeeklyReviewHandlers } from "./weekly-review-handlers";
import type { WeeklyReviewHandlers } from "./weekly-review-handlers";

/**
 * `/api/v1/weekly-reviews` の composition root(T-301)。他の container と同様、
 * 初回リクエスト時まで構築を遅延させる(`next build` が env 検証や DB 接続を実行しないようにするため)。
 */
async function buildWeeklyReviewHandlers(): Promise<WeeklyReviewHandlers> {
  const env = parseEnv(process.env);
  const { auth, prisma } = await getAuthContainer();

  const reviewRepository = createPrismaWeeklyReviewRepository(prisma);
  const now: Clock = () => new Date();
  const createDeps = {
    reviewRepository,
    habitRepository: createPrismaHabitRepository(prisma),
    entryRepository: createPrismaHabitEntryRepository(prisma),
    checkInRepository: createPrismaDailyCheckInRepository(prisma),
    profileRepository: createPrismaProfileRepository(prisma),
    now,
  };

  return createWeeklyReviewHandlers({
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    // 認証(誰か)のみをここで判定する。認可(自分の分のみ)は repository の query 条件で行う。
    resolveActorUserId: async () => actorUserIdFromSession(await auth()),
    useCases: {
      create: (input) => createWeeklyReviewUseCase(createDeps, input),
      get: (input) => getWeeklyReviewUseCase({ reviewRepository }, input),
      list: (input) => listWeeklyReviewsUseCase({ reviewRepository }, input),
      update: (input) => updateWeeklyReviewUseCase({ reviewRepository, now }, input),
    },
  });
}

let handlersPromise: Promise<WeeklyReviewHandlers> | undefined;

export function getWeeklyReviewHandlers(): Promise<WeeklyReviewHandlers> {
  handlersPromise ??= buildWeeklyReviewHandlers();
  return handlersPromise;
}
