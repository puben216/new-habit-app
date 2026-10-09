import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ReminderEmailError } from "@habit-app/application";
import type { ReminderEmailPort } from "@habit-app/application";

/**
 * SES(SESv2)によるリマインドメール送信(docs/specs/notification-delivery.md NDL-004/006)。
 *
 * - SDK の型・エラーはこのファイルの外へ出さない。失敗は `ReminderEmailError` に分類する。
 * - SDK 自身の再試行は無効(`maxAttempts: 1`)にし、再試行は配送の状態(backoff + jitter、最大 5 回)に一本化する。
 * - 明示的な timeout を `AbortSignal` で課す。
 * - エラーメッセージ・コードに宛先・件名・本文・provider の応答本文を含めない。
 */

export const SES_SEND_TIMEOUT_MS = 10_000;

export interface SesReminderSenderConfig {
  readonly client: SESv2Client;
  /** 送信元(`EMAIL_FROM`)。 */
  readonly from: string;
  /** bounce/complaint を受け取る configuration set。 */
  readonly configurationSet: string;
  readonly timeoutMs?: number;
}

/** 呼び出し側のリクエスト自体が不正・拒否された(再試行しても同じ結果になる)エラー名。 */
const PERMANENT_ERROR_NAMES: ReadonlyMap<string, string> = new Map([
  ["MessageRejected", "rejected"],
  ["MailFromDomainNotVerifiedException", "domain_not_verified"],
  ["AccountSuspendedException", "account_suspended"],
  ["SendingPausedException", "sending_paused"],
  ["BadRequestException", "bad_request"],
  ["NotFoundException", "not_found"],
]);

/** スロットリング・クォータ(時間をおけば成功しうる)のエラー名。 */
const THROTTLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TooManyRequestsException",
  "ThrottlingException",
  "LimitExceededException",
]);

interface SdkErrorShape {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown };
}

/** SES の失敗を一時的/永続的に分類する(エラー名と HTTP status の表。詳細は Runbook)。 */
export function classifySesError(error: unknown): ReminderEmailError {
  const shape: SdkErrorShape = typeof error === "object" && error !== null ? error : {};
  const name = typeof shape.name === "string" ? shape.name : "";
  const status =
    typeof shape.$metadata?.httpStatusCode === "number" ? shape.$metadata.httpStatusCode : null;

  if (name === "AbortError" || name === "TimeoutError") {
    return new ReminderEmailError("transient", "timeout");
  }
  if (THROTTLE_ERROR_NAMES.has(name) || status === 429) {
    return new ReminderEmailError("transient", "throttled");
  }
  const permanent = PERMANENT_ERROR_NAMES.get(name);
  if (permanent !== undefined) return new ReminderEmailError("permanent", permanent);
  if (status !== null && status >= 500) return new ReminderEmailError("transient", "server_error");
  if (status !== null && status >= 400) return new ReminderEmailError("permanent", "client_error");
  // 応答がない(接続リセット、DNS 失敗など)は一時的な障害として扱う。
  return new ReminderEmailError("transient", "network_error");
}

export function createSesReminderSender(config: SesReminderSenderConfig): ReminderEmailPort {
  const timeoutMs = config.timeoutMs ?? SES_SEND_TIMEOUT_MS;
  return {
    async send(email) {
      const command = new SendEmailCommand({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [email.to] },
        ConfigurationSetName: config.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: { Text: { Data: email.text, Charset: "UTF-8" } },
            // RFC 8058: メールクライアントのワンクリック配信停止。
            Headers: [
              { Name: "List-Unsubscribe", Value: `<${email.unsubscribeUrl}>` },
              { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
            ],
          },
        },
      });

      let messageId: string | undefined;
      try {
        const result = await config.client.send(command, {
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        messageId = result.MessageId;
      } catch (error) {
        throw classifySesError(error);
      }
      // 送信は受理されたが ID が得られない場合は、再試行すると重複送信になるため永続エラーにする。
      if (messageId === undefined || messageId.length === 0) {
        throw new ReminderEmailError("permanent", "invalid_response");
      }
      return { providerMessageId: messageId };
    },
  };
}

/** SES クライアントの標準構成(SDK の再試行は無効。endpoint 上書きはテスト・ローカル用)。 */
export function createSesClient(options: {
  readonly region: string;
  readonly endpoint?: string;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}): SESv2Client {
  return new SESv2Client({
    region: options.region,
    maxAttempts: 1,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
}
