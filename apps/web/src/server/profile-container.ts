import { parseEnv } from "@habit-app/config";
import { getMyProfile, updateMyProfile } from "@habit-app/application";
import { createPrismaProfileRepository } from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createProfileHandlers, type ProfileHandlers } from "./profile-handlers";
import { actorUserIdFromSession } from "./session-actor";

/**
 * `/api/v1/me` の composition root(T-102)。auth-container と同様、モジュール読み込み時ではなく
 * 初回リクエスト時まで遅延構築する(`next build` が env 検証や DB 接続で失敗しないようにするため)。
 */
async function buildProfileHandlers(): Promise<ProfileHandlers> {
  const env = parseEnv(process.env);
  const { auth, prisma } = await getAuthContainer();
  const profileRepository = createPrismaProfileRepository(prisma);

  return createProfileHandlers({
    getActorUserId: async () => actorUserIdFromSession(await auth()),
    getMyProfile: (actor) => getMyProfile({ profileRepository }, actor),
    updateMyProfile: (actor, input) => updateMyProfile({ profileRepository }, actor, input),
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
  });
}

let handlersPromise: Promise<ProfileHandlers> | undefined;

export function getProfileHandlers(): Promise<ProfileHandlers> {
  handlersPromise ??= buildProfileHandlers();
  return handlersPromise;
}
