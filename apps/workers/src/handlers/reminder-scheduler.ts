import { getScheduler } from "../notification/container";

/** EventBridge Scheduler(5 分間隔)から起動される。送信枠に達した配送を作り、queue へ投入する。 */
export async function handler(): Promise<unknown> {
  return (await getScheduler())();
}
