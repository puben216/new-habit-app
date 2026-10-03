import { randomUUID } from "node:crypto";

import type { IdGeneratorPort } from "@habit-app/application";

/** 外部公開 ID(UUID v4)を採番する。 */
export function createUuidGenerator(): IdGeneratorPort {
  return { generate: () => randomUUID() };
}
