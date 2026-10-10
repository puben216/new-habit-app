import {
  createAiJobProcessDeps,
  createPrismaClient,
  createSecretsManagerClient,
  createSecretsReader,
} from "@habit-app/infrastructure/worker";
import { parseWorkerEnv } from "@habit-app/config";
import type { ProcessAiJobDeps } from "@habit-app/application";

/**
 * `ai-coaching` queue consumer の composition root(T-303)。コールドスタート時に 1 度だけ構築する
 * (Lambda の実行環境を再利用し、DB 接続を使い回す)。DB の接続文字列は、直接指定(ローカル/テスト)か
 * Secrets Manager の ARN から取得する(値をログ・エラーに含めない)。
 */
let depsPromise: Promise<ProcessAiJobDeps> | undefined;

export function getAiCoachingDeps(): Promise<ProcessAiJobDeps> {
  depsPromise ??= (async () => {
    const env = parseWorkerEnv(process.env);
    let databaseUrl = env.DATABASE_URL;
    if (databaseUrl === undefined) {
      const arn = env.DATABASE_URL_SECRET_ARN;
      if (arn === undefined) throw new Error("DATABASE_URL_SECRET_ARN is required");
      databaseUrl = await createSecretsReader({
        client: createSecretsManagerClient({ region: env.AWS_REGION }),
      }).getSecretString(arn);
    }
    return createAiJobProcessDeps(createPrismaClient(databaseUrl), {
      provider: env.AI_PROVIDER,
      publicationEnabled: env.AI_PUBLICATION_ENABLED,
    });
  })();
  return depsPromise;
}
