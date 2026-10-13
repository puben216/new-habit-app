import { getPurge } from "../account/container";

/** 猶予期間が終わった削除予約のアカウントを削除する(日次。Feature Flag `ACCOUNT_PURGE_ENABLED`)。 */
export async function handler(): Promise<unknown> {
  return (await getPurge())();
}
