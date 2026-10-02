import {
  archiveHabitUseCase,
  createHabitUseCase,
  getHabitUseCase,
  listHabitsUseCase,
  updateHabitUseCase,
} from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { parseEnv } from "@habit-app/config";
import { createPrismaHabitRepository, createUuidGenerator } from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createHabitHandlers } from "./habit-handlers";
import type { HabitHandlers } from "./habit-handlers";

/**
 * `/api/v1/habits` route の composition root。auth-container と同様、初回リクエスト時まで
 * 構築を遅延させる(`next build` が env 検証や DB 接続を実行しないようにするため)。
 */

/** `session.user.id`(users.id の十進文字列)のみを actor として受け付ける。 */
const ACTOR_USER_ID_PATTERN = /^[1-9][0-9]*$/;

async function buildHabitHandlers(): Promise<HabitHandlers> {
  const env = parseEnv(process.env);
  const { auth, prisma } = await getAuthContainer();

  const habitRepository = createPrismaHabitRepository(prisma);
  const idGenerator = createUuidGenerator();
  const now: Clock = () => new Date();

  return createHabitHandlers({
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    async resolveActorUserId() {
      // 認証(誰か)のみをここで判定する。認可(所有者のみ)は repository の query 条件で行う。
      const session = await auth();
      const userId = session?.user?.id;
      return typeof userId === "string" && ACTOR_USER_ID_PATTERN.test(userId) ? userId : null;
    },
    useCases: {
      create: (input) => createHabitUseCase({ habitRepository, idGenerator, now }, input),
      list: (input) => listHabitsUseCase({ habitRepository }, input),
      get: (input) => getHabitUseCase({ habitRepository }, input),
      update: (input) => updateHabitUseCase({ habitRepository, now }, input),
      archive: (input) => archiveHabitUseCase({ habitRepository, now }, input),
    },
  });
}

let handlersPromise: Promise<HabitHandlers> | undefined;

export function getHabitHandlers(): Promise<HabitHandlers> {
  handlersPromise ??= buildHabitHandlers();
  return handlersPromise;
}
