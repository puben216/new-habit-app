import { getDelivery } from "../notification/container";
import type { SqsBatchResponse, SqsEvent } from "../notification/handlers";

/** notifications queue の consumer。1 message = 1 配送。部分失敗(batchItemFailures)で応答する。 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  return (await getDelivery())(event);
}
