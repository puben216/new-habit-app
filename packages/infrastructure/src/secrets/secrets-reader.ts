import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Secrets Manager から文字列の secret を読む(docs/specs/notification-delivery.md セキュリティ)。
 * 値は Lambda の実行環境内のメモリにだけ保持する(コールドスタートごとに 1 回読む)。
 * 値・ARN をログやエラーメッセージに含めない。
 */

export const SECRETS_READ_TIMEOUT_MS = 5_000;

export interface SecretsReader {
  getSecretString(secretId: string): Promise<string>;
}

export function createSecretsReader(options: {
  readonly client: SecretsManagerClient;
  readonly timeoutMs?: number;
}): SecretsReader {
  const timeoutMs = options.timeoutMs ?? SECRETS_READ_TIMEOUT_MS;
  const cache = new Map<string, Promise<string>>();

  async function read(secretId: string): Promise<string> {
    let value: string | undefined;
    try {
      const result = await options.client.send(new GetSecretValueCommand({ SecretId: secretId }), {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      value = result.SecretString;
    } catch {
      throw new Error("failed to read secret");
    }
    if (value === undefined || value.length === 0) throw new Error("secret has no string value");
    return value;
  }

  return {
    getSecretString(secretId) {
      let cached = cache.get(secretId);
      if (cached === undefined) {
        cached = read(secretId);
        cache.set(secretId, cached);
        // 失敗した読み取りを保持し続けない(次の呼び出しで再試行できるようにする)。
        cached.catch(() => cache.delete(secretId));
      }
      return cached;
    },
  };
}

export function createSecretsManagerClient(options: {
  readonly region: string;
  readonly endpoint?: string;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}): SecretsManagerClient {
  return new SecretsManagerClient({
    region: options.region,
    maxAttempts: 2,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
}
