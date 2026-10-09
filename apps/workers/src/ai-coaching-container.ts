import { parseWorkerEnv } from "@habit-app/config";
import { createAiJobProcessDeps, createPrismaClient } from "@habit-app/infrastructure/worker";
import type { ProcessAiJobDeps } from "@habit-app/application";

/**
 * `ai-coaching` queue consumer の composition root(T-303)。コールドスタート時に 1 度だけ構築する
 * (Lambda の実行環境を再利用し、DB 接続を使い回す)。
 */
let depsPromise: Promise<ProcessAiJobDeps> | undefined;

export function getAiCoachingDeps(): Promise<ProcessAiJobDeps> {
  depsPromise ??= (async () => {
    const env = parseWorkerEnv(process.env);
    const prisma = createPrismaClient(env.DATABASE_URL);
    return createAiJobProcessDeps(prisma, {
      provider: env.AI_PROVIDER,
      publicationEnabled: env.AI_PUBLICATION_ENABLED,
    });
  })();
  return depsPromise;
}
