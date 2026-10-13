import { getCleanup } from "../export/container";

/** 期限切れのエクスポートの成果物と、古い終了済みの行を削除する(日次。Feature Flag `DATA_EXPORT_ENABLED`)。 */
export async function handler(): Promise<unknown> {
  return (await getCleanup())();
}
