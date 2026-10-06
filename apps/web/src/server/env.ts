import { parseEnv, type Env } from "@habit-app/config";

/**
 * `apps/web` の server 側が env を読む唯一の入口(docs/specs/web-ui-foundation.md WUI-006)。
 *
 * モジュール読み込み時ではなく初回利用時に検証する(`next build` が route module を import
 * するだけで env 未整備により失敗しないようにするため。auth-container と同じ方針)。
 * 結果は memoize する。検証に失敗した場合は memoize せず、次回の呼び出しで再度検証する。
 * エラーには変数名と検証メッセージだけを含み、値は含めない(`parseEnv` の契約)。
 */
export function createServerEnvGetter(
  parse: (source: NodeJS.ProcessEnv) => Env,
  source: () => NodeJS.ProcessEnv,
): () => Env {
  let cached: Env | undefined;
  return () => {
    cached ??= parse(source());
    return cached;
  };
}

export const getServerEnv: () => Env = createServerEnvGetter(parseEnv, () => process.env);
