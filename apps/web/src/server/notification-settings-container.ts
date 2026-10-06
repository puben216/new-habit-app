import {
  getNotificationSettingsUseCase,
  upsertNotificationSettingsUseCase,
} from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { parseEnv } from "@habit-app/config";
import {
  createPrismaNotificationSettingsRepository,
  createPrismaProfileRepository,
} from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createNotificationSettingsHandlers } from "./notification-settings-handlers";
import type { NotificationSettingsHandlers } from "./notification-settings-handlers";
import { actorUserIdFromSession } from "./session-actor";

/**
 * `/api/v1/notification-settings` の composition root(T-401)。他の container と同様、
 * 初回リクエスト時まで構築を遅延させる(`next build` が env 検証や DB 接続を実行しないようにするため)。
 */
async function buildNotificationSettingsHandlers(): Promise<NotificationSettingsHandlers> {
  const env = parseEnv(process.env);
  const { auth, prisma } = await getAuthContainer();

  const settingsRepository = createPrismaNotificationSettingsRepository(prisma);
  const profileRepository = createPrismaProfileRepository(prisma);
  const now: Clock = () => new Date();

  return createNotificationSettingsHandlers({
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    // 認証(誰か)のみをここで判定する。認可(自分の分のみ)は repository の query 条件で行う。
    resolveActorUserId: async () => actorUserIdFromSession(await auth()),
    useCases: {
      get: (input) =>
        getNotificationSettingsUseCase({ settingsRepository, profileRepository }, input),
      upsert: (input) =>
        upsertNotificationSettingsUseCase({ settingsRepository, profileRepository, now }, input),
    },
  });
}

let handlersPromise: Promise<NotificationSettingsHandlers> | undefined;

export function getNotificationSettingsHandlers(): Promise<NotificationSettingsHandlers> {
  handlersPromise ??= buildNotificationSettingsHandlers();
  return handlersPromise;
}
