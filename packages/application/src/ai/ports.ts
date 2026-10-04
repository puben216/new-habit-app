import type {
  AiPurpose,
  ContentSafetyReasonCode,
  ContentSafetyStatus,
  HabitDesignInputV1,
  WeeklyImprovementInputV1,
} from "@habit-app/contracts";
import type { RightsDenyReason, RightsRecord, RightsUse } from "@habit-app/domain";

/**
 * AI coaching の port(docs/specs/ai-contracts.md AIC-002)。
 * provider 固有の型・response object をここへ漏らさない。
 */

export type AiCoachRequest =
  | { readonly purpose: "habit_design"; readonly input: HabitDesignInputV1 }
  | { readonly purpose: "weekly_improvement"; readonly input: WeeklyImprovementInputV1 };

export type AiCoachGenerateParams = AiCoachRequest & {
  readonly promptVersion: string;
  /** adapter が必ず守る生成制約(第三者コンテンツ・ブランド保護)。 */
  readonly systemPolicy: string;
  /** timeout や中断で abort される。adapter は外部呼び出しへ伝播させる。 */
  readonly signal: AbortSignal;
};

export type AiCoachGenerateResult =
  | {
      readonly outcome: "completed";
      /** 未検証の出力。Application が schema で絞り込む。 */
      readonly rawOutput: unknown;
      readonly model: string;
    }
  | { readonly outcome: "refusal" };

export const AI_PROVIDER_ERROR_KINDS = [
  "rate_limited",
  "timeout",
  "server_error",
  "connection",
  "invalid_request",
  "unknown",
] as const;
export type AiCoachProviderErrorKind = (typeof AI_PROVIDER_ERROR_KINDS)[number];

/** 一時的障害として再試行してよい分類。 */
export const RETRYABLE_PROVIDER_ERROR_KINDS: readonly AiCoachProviderErrorKind[] = [
  "rate_limited",
  "timeout",
  "server_error",
  "connection",
];

/** adapter が provider の失敗を分類して投げる error。メッセージに入力・本文を含めない。 */
export class AiCoachProviderError extends Error {
  readonly kind: AiCoachProviderErrorKind;

  constructor(kind: AiCoachProviderErrorKind) {
    super(`ai provider error: ${kind}`);
    this.name = new.target.name;
    this.kind = kind;
  }
}

export interface AiCoachPort {
  generate(params: AiCoachGenerateParams): Promise<AiCoachGenerateResult>;
}

/** 権利資料 registry。未登録は `null`(use case が deny とする)。 */
export interface ThirdPartyRightsRegistryPort {
  find(sourceId: string): Promise<RightsRecord | null>;
}

export const FALLBACK_REASONS = [
  "disabled",
  "input_rejected",
  "provider_unavailable",
  "provider_refusal",
  "invalid_output",
  "safety_rejected",
  "validator_error",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** 監査 record。入力・生成本文・subject ID を持たない(AIC-007)。 */
export type AiAuditEvent =
  | {
      readonly kind: "generation";
      readonly purpose: AiPurpose;
      readonly source: "ai" | "fallback";
      readonly status: ContentSafetyStatus;
      readonly reasonCodes: readonly ContentSafetyReasonCode[];
      readonly fallbackReason: FallbackReason | null;
      readonly schemaVersion: string;
      readonly promptVersion: string;
      readonly validatorVersion: string;
      readonly fallbackVersion: string | null;
      readonly attempts: number;
    }
  | {
      readonly kind: "corpus_admission";
      readonly sourceId: string;
      readonly use: RightsUse;
      readonly admitted: boolean;
      readonly reason: RightsDenyReason | null;
    };

export interface AiAuditSinkPort {
  record(event: AiAuditEvent): Promise<void>;
}
