/**
 * AI job の状態と、決定的な入力 fingerprint のための正規化(docs/specs/ai-queue-pipeline.md)。
 * 状態遷移の規則は ここだけが持ち、Application/Infrastructure は再実装しない(AJOB-INV-003/004)。
 */

export const AI_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "fallback"] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

export function isAiJobStatus(value: unknown): value is AiJobStatus {
  return typeof value === "string" && (AI_JOB_STATUSES as readonly string[]).includes(value);
}

/** 終端状態。以後 status・result は変更しない(AJOB-INV-004)。 */
export function isTerminalAiJobStatus(status: AiJobStatus): boolean {
  switch (status) {
    case "succeeded":
    case "failed":
    case "fallback":
      return true;
    case "queued":
    case "running":
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export type AiJobClaimDecision = "claim" | "in_progress" | "finished";

/**
 * worker が job を claim できるかを判定する(AJOB-003)。
 * `queued` は claim できる。`running` は lease を過ぎていれば引き継げ、lease 内なら実行中として
 * 再配送に回す。終端状態は何もしない。
 */
export function decideAiJobClaim(input: {
  readonly status: AiJobStatus;
  readonly leaseExpired: boolean;
}): AiJobClaimDecision {
  switch (input.status) {
    case "queued":
      return "claim";
    case "running":
      return input.leaseExpired ? "claim" : "in_progress";
    case "succeeded":
    case "failed":
    case "fallback":
      return "finished";
    default: {
      const exhaustive: never = input.status;
      return exhaustive;
    }
  }
}

/** `canonicalJson` が受け付けない値(関数・undefined・循環・非有限数など)。 */
export class NonCanonicalValueError extends Error {
  constructor() {
    super("value cannot be canonicalized");
    this.name = new.target.name;
  }
}

/**
 * キーを辞書順に整列した決定的な JSON 文字列を返す(fingerprint の入力)。
 * オブジェクトのキー挿入順に依存せず、配列の順序は保つ。`undefined` のプロパティは省略し、
 * 関数・symbol・bigint・非有限数・循環参照は拒否する。
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new NonCanonicalValueError();
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new NonCanonicalValueError();
  }

  const object = value as object;
  if (ancestors.has(object)) throw new NonCanonicalValueError();
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => serialize(item === undefined ? null : item, ancestors)).join(",")}]`;
    }
    const entries = Object.entries(object as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}
