import { getProcess } from "../export/container";
import type { DataExportBatchResponse, DataExportQueueBatch } from "@habit-app/application";

/** export queue の consumer。1 message = 1 エクスポート。部分失敗(batchItemFailures)で応答する。 */
export async function handler(event: DataExportQueueBatch): Promise<DataExportBatchResponse> {
  return (await getProcess())(event);
}
