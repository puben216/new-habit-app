import { getFeedback } from "../notification/container";
import type { SqsBatchResponse, SqsEvent } from "../notification/handlers";

/** SES の bounce/complaint(SNS → SQS)の consumer。Permanent bounce と complaint を suppression に記録する。 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  return (await getFeedback())(event);
}
