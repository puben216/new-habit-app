import { randomUUID } from "node:crypto";

/**
 * docs/specs/auth-adapter.md API and Events 節の共通エラー形式(Problem Details)。
 * `/api/v1/auth/*` endpoint 専用(Auth.js 標準 route `/api/auth/*` はこの対象外)。
 */
export interface ProblemDetails {
  readonly code: string;
  readonly message: string;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  readonly requestId: string;
}

export function createProblemDetails(input: {
  readonly code: string;
  readonly message: string;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
}): ProblemDetails {
  return { ...input, requestId: randomUUID() };
}
