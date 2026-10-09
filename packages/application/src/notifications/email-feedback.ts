import type { Clock } from "../auth";
import type { EmailSuppressionPort, ReminderDeliveryRepositoryPort } from "./delivery-ports";

/** SES の configuration set イベントのうち、判断に必要な最小限(docs/specs/notification-delivery.md NDL-008)。 */
export type EmailFeedbackEvent =
  | { readonly kind: "bounce_permanent"; readonly providerMessageId: string }
  | { readonly kind: "bounce_transient"; readonly providerMessageId: string }
  | { readonly kind: "complaint"; readonly providerMessageId: string };

export interface HandleEmailFeedbackDeps {
  readonly deliveryRepository: Pick<
    ReminderDeliveryRepositoryPort,
    "findUserIdByProviderMessageId"
  >;
  readonly suppressions: EmailSuppressionPort;
  readonly now: Clock;
}

export type HandleEmailFeedbackOutcome = "suppressed" | "ignored";

/**
 * Permanent bounce と complaint はユーザーを suppression に記録する(冪等)。
 * Transient bounce と未知の message ID は何もしない(再処理しても結果が同じ)。
 */
export async function handleEmailFeedbackUseCase(
  deps: HandleEmailFeedbackDeps,
  event: EmailFeedbackEvent,
): Promise<HandleEmailFeedbackOutcome> {
  if (event.kind === "bounce_transient") return "ignored";

  const userId = await deps.deliveryRepository.findUserIdByProviderMessageId(
    event.providerMessageId,
  );
  if (userId === null) return "ignored";

  await deps.suppressions.suppress({
    userId,
    reason: event.kind === "complaint" ? "complaint" : "bounce",
    now: deps.now(),
  });
  return "suppressed";
}
