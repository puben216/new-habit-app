import type { PurgeSummary } from "@habit-app/application";

/**
 * アカウント削除ジョブの Lambda handler 本体(docs/specs/account-deletion.md ACD-006)。
 * AWS・DB に依存しない純粋なロジックだけを持ち、use case は依存として受け取る。
 *
 * ログは件数のみ(ユーザーの識別子・メール・例外メッセージを出さない)。
 */

export type LogCounts = Readonly<Record<string, number | boolean | string>>;
export type Logger = (event: string, counts: LogCounts) => void;

/** 構造化ログ基盤が未導入のため、実行ごとに件数だけの 1 行 JSON を出す。 */
export const consoleLogger: Logger = (event, counts) => {
  console.log(JSON.stringify({ event, ...counts }));
};

export interface PurgeHandlerDeps {
  readonly enabled: boolean;
  readonly run: () => Promise<PurgeSummary>;
  readonly log: Logger;
}

/**
 * EventBridge Scheduler(日次)または手動実行で起動される。Feature Flag が無効なら DB に触れずに終了する。
 * 失敗したユーザーがいても例外にはしない(次回の実行で再試行する)。失敗件数はログに残る。
 */
export function createPurgeHandler(deps: PurgeHandlerDeps) {
  return async (): Promise<PurgeSummary | { readonly disabled: true }> => {
    if (!deps.enabled) {
      deps.log("account.purge", { disabled: true });
      return { disabled: true };
    }
    const summary = await deps.run();
    deps.log("account.purge", { ...summary });
    return summary;
  };
}
