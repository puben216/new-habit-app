import { getDashboardUseCase } from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import {
  createPrismaHabitEntryRepository,
  createPrismaHabitRepository,
  createPrismaProfileRepository,
} from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createDashboardHandlers } from "./dashboard-handlers";
import type { DashboardHandlers } from "./dashboard-handlers";
import { actorUserIdFromSession } from "./session-actor";

/**
 * `/api/v1/dashboard` の composition root(T-204)。
 * 他の container と同様、初回リクエスト時まで構築を遅延させる
 * (`next build` が env 検証や DB 接続を実行しないようにするため)。
 */
async function buildDashboardHandlers(): Promise<DashboardHandlers> {
  const { auth, prisma } = await getAuthContainer();

  const deps = {
    habitRepository: createPrismaHabitRepository(prisma),
    entryRepository: createPrismaHabitEntryRepository(prisma),
    profileRepository: createPrismaProfileRepository(prisma),
    now: ((): Date => new Date()) satisfies Clock,
  };

  return createDashboardHandlers({
    // 認証(誰か)のみをここで判定する。認可(所有者のみ)は repository の query 条件で行う。
    resolveActorUserId: async () => actorUserIdFromSession(await auth()),
    useCases: {
      get: (input) => getDashboardUseCase(deps, input),
    },
  });
}

let handlersPromise: Promise<DashboardHandlers> | undefined;

export function getDashboardHandlers(): Promise<DashboardHandlers> {
  handlersPromise ??= buildDashboardHandlers();
  return handlersPromise;
}
