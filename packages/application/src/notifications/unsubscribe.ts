import type { Clock } from "../auth";
import type { UnsubscribeTokenPort } from "./delivery-ports";
import type { NotificationSettingsRepositoryPort } from "./ports";

export interface UnsubscribeDeps {
  readonly unsubscribeTokens: UnsubscribeTokenPort;
  readonly settingsRepository: Pick<NotificationSettingsRepositoryPort, "disableByUserPublicId">;
  readonly now: Clock;
}

export type UnsubscribeOutcome = "unsubscribed" | "invalid_token";

/**
 * メール内の署名付き token で通知を無効にする(NDL-007)。冪等で、設定が無い/既に無効でも成功。
 * token が不正な理由(形式・署名・用途・未知のユーザー)は区別しない。
 */
export async function unsubscribeUseCase(
  deps: UnsubscribeDeps,
  input: { readonly token: string },
): Promise<UnsubscribeOutcome> {
  const userPublicId = deps.unsubscribeTokens.verify(input.token);
  if (userPublicId === null) return "invalid_token";
  await deps.settingsRepository.disableByUserPublicId({ userPublicId, now: deps.now() });
  return "unsubscribed";
}
