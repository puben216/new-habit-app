import {
  getScheduleOnDateUseCase,
  getTodayScheduleUseCase,
  upsertHabitEntryUseCase,
} from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { getServerEnv } from "./env";
import {
  createPrismaHabitEntryRepository,
  createPrismaHabitRepository,
  createPrismaProfileRepository,
} from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createEntryHandlers } from "./entry-handlers";
import type { EntryHandlers } from "./entry-handlers";
import { actorUserIdFromSession } from "./session-actor";

/**
 * `/api/v1/schedule/today` と `/api/v1/habits/{habitId}/entries/{date}` の composition root(T-202)。
 * 他の container と同様、初回リクエスト時まで構築を遅延させる
 * (`next build` が env 検証や DB 接続を実行しないようにするため)。
 */
async function buildEntryHandlers(): Promise<EntryHandlers> {
  const env = getServerEnv();
  const { auth, prisma } = await getAuthContainer();

  const deps = {
    habitRepository: createPrismaHabitRepository(prisma),
    entryRepository: createPrismaHabitEntryRepository(prisma),
    profileRepository: createPrismaProfileRepository(prisma),
    now: ((): Date => new Date()) satisfies Clock,
  };

  return createEntryHandlers({
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    // 認証(誰か)のみをここで判定する。認可(所有者のみ)は repository の query 条件で行う。
    resolveActorUserId: async () => actorUserIdFromSession(await auth()),
    useCases: {
      getToday: (input) => getTodayScheduleUseCase(deps, input),
      getOnDate: (input) => getScheduleOnDateUseCase(deps, input),
      upsert: (input) => upsertHabitEntryUseCase(deps, input),
    },
  });
}

let handlersPromise: Promise<EntryHandlers> | undefined;

export function getEntryHandlers(): Promise<EntryHandlers> {
  handlersPromise ??= buildEntryHandlers();
  return handlersPromise;
}
