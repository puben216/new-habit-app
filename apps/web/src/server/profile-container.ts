import { getServerEnv } from "./env";
import { getMyProfile, updateMyProfile, type ProfileView } from "@habit-app/application";
import { createPrismaProfileRepository } from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createProfileHandlers, type ProfileHandlers } from "./profile-handlers";
import { actorUserIdFromSession } from "./session-actor";

/**
 * `/api/v1/me` の composition root(T-102)。auth-container と同様、モジュール読み込み時ではなく
 * 初回リクエスト時まで遅延構築する(`next build` が env 検証や DB 接続で失敗しないようにするため)。
 */
async function buildProfileHandlers(): Promise<ProfileHandlers> {
  const env = getServerEnv();
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

/**
 * Server Component 用。actor 自身のプロフィールを取得する(未作成なら既定値で遅延作成。PROF-001)。
 * オンボーディング完了の判定(layout)に使う。
 */
export async function getProfileForActor(userId: string): Promise<ProfileView> {
  const { prisma } = await getAuthContainer();
  const profileRepository = createPrismaProfileRepository(prisma);
  return getMyProfile({ profileRepository }, { userId });
}
