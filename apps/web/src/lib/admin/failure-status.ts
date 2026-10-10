import { AI_JOB_FAILURE_STATUSES, NOTIFICATION_FAILURE_STATUSES } from "@habit-app/contracts";

/** 一覧の絞り込み。`status` クエリは個人情報を含まないので URL に載せてよい(ADS-006)。 */
export type FailureList = "notification" | "ai";

const ALLOWED: Readonly<Record<FailureList, readonly string[]>> = {
  notification: NOTIFICATION_FAILURE_STATUSES,
  ai: AI_JOB_FAILURE_STATUSES,
};

/** 許可された状態だけを通し、それ以外(未指定・未知・複数指定)は「すべて」(`undefined`)にする。 */
export function parseFailureStatus(
  list: FailureList,
  raw: string | readonly string[] | undefined,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  return ALLOWED[list].includes(raw) ? raw : undefined;
}
