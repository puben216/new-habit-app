import {
  REMINDER_REQUEUE_AFTER_MS,
  REMINDER_SCAN_PAGE_SIZE,
  isReminderDue,
  isReminderExpired,
  localDateAt,
  addCalendarDays,
  reminderDeduplicationKey,
  resolveReminderSlot,
} from "@habit-app/domain";

import type { Clock } from "../auth";
import type { ReminderDeliveryRepositoryPort, ReminderQueuePort } from "./delivery-ports";

/** 1 回の実行で投入する最大件数(無限ループと過負荷の防止)。 */
const ENQUEUE_PAGE_SIZE = 100;
const ENQUEUE_MAX_PAGES = 50;

export interface ScheduleDueRemindersDeps {
  readonly deliveryRepository: ReminderDeliveryRepositoryPort;
  readonly queue: ReminderQueuePort;
  readonly now: Clock;
}

/** 個人情報を含まない実行結果(件数のみ)。運用ログとメトリクスに使う。 */
export interface ScheduleDueRemindersSummary {
  readonly scanned: number;
  readonly created: number;
  /** 設定の timezone/時刻が不正で枠を計算できなかった件数。 */
  readonly invalidSettings: number;
  readonly exhausted: number;
  readonly enqueued: number;
  readonly enqueueFailed: number;
}

/**
 * 送信枠に達した設定の配送を作り(NDL-001)、投入すべき配送を queue へ載せる(NDL-002)。
 * 何度実行しても重複しない(dedupe キー)。`now()` は 1 回だけ呼ぶ。
 */
export async function scheduleDueRemindersUseCase(
  deps: ScheduleDueRemindersDeps,
): Promise<ScheduleDueRemindersSummary> {
  const now = deps.now();
  let scanned = 0;
  let created = 0;
  let invalidSettings = 0;

  let afterSettingId: string | null = null;
  for (;;) {
    const settings = await deps.deliveryRepository.listEnabledSettings({
      afterSettingId,
      limit: REMINDER_SCAN_PAGE_SIZE,
    });
    for (const setting of settings) {
      scanned += 1;
      try {
        const today = localDateAt(now, setting.timezone);
        for (const localDate of [today, addCalendarDays(today, -1)]) {
          const slot = resolveReminderSlot(localDate, setting.localTime, setting.timezone);
          if (!isReminderDue(slot, now) || isReminderExpired(slot, now)) continue;
          const result = await deps.deliveryRepository.createPendingIfAbsent({
            setting,
            localDate,
            scheduledAt: slot,
            deduplicationKey: reminderDeduplicationKey(setting.settingId, localDate),
            now,
          });
          if (result.created) created += 1;
        }
      } catch (error) {
        // 保存済みの値が計算できない設定(データ破損)は件数だけ数えて他の設定を続ける。
        // DB 障害などの予期しない例外は握りつぶさず呼び出し側へ伝える。
        if (!isCalculationError(error)) throw error;
        invalidSettings += 1;
      }
    }
    const last = settings[settings.length - 1];
    if (settings.length < REMINDER_SCAN_PAGE_SIZE || last === undefined) break;
    afterSettingId = last.settingId;
  }

  const exhausted = await deps.deliveryRepository.failExhausted({ now });

  let enqueued = 0;
  let enqueueFailed = 0;
  const requeueBefore = new Date(now.getTime() - REMINDER_REQUEUE_AFTER_MS);
  for (let page = 0; page < ENQUEUE_MAX_PAGES; page += 1) {
    const ids = await deps.deliveryRepository.listEnqueueCandidates({
      now,
      requeueBefore,
      limit: ENQUEUE_PAGE_SIZE,
    });
    if (ids.length === 0) break;
    const accepted = await deps.queue.enqueue(ids);
    if (accepted.length > 0) {
      await deps.deliveryRepository.markEnqueued({ ids: accepted, now });
    }
    enqueued += accepted.length;
    enqueueFailed += ids.length - accepted.length;
    // 投入に失敗した ID が残る限り同じ候補を取り直してしまうため、そのページで打ち切る(次回の実行で再試行する)。
    if (accepted.length < ids.length) break;
  }

  return { scanned, created, invalidSettings, exhausted, enqueued, enqueueFailed };
}

/** Domain の時刻計算が投げる、入力値に起因するエラーか。 */
function isCalculationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "InvalidNotificationPreferenceError" ||
      error.name === "InvalidScheduleCalculationInputError")
  );
}
