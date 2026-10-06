import {
  AI_SCHEMA_VERSION,
  habitDesignProposalV1Schema,
  weeklyImprovementPlanV1Schema,
  type AiPurpose,
  type ContentSafetyReasonCode,
  type HabitDesignProposalV1,
  type WeeklyImprovementPlanV1,
} from "@habit-app/contracts";
import {
  CONTENT_VALIDATOR_VERSION,
  inspectGenerationRequest,
  validateGeneratedContent,
  type ContentSafetyAssessment,
  type ContentSafetyPolicy,
} from "./content-validator";
import {
  SAFE_FALLBACK_VERSION,
  buildHabitDesignFallback,
  buildWeeklyImprovementFallback,
} from "./fallback";
import { COACHING_SYSTEM_POLICY_V1 } from "./policy";
import {
  AiCoachProviderError,
  RETRYABLE_PROVIDER_ERROR_KINDS,
  type AiAuditSinkPort,
  type AiCoachPort,
  type AiCoachRequest,
  type FallbackReason,
} from "./ports";
import { collectStrings } from "./text-inspection";

/** 一時的障害の最大 attempt 数(docs/05 タイムアウト・再試行)。 */
export const MAX_PROVIDER_ATTEMPTS = 3;
/** validator 拒否後の再生成は最大 1 回(AIC-INV-004)。 */
export const MAX_REGENERATIONS = 1;

export interface GenerateSafeCoachingConfig {
  readonly promptVersion: string;
  /** 1 attempt あたりの timeout。 */
  readonly attemptTimeoutMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export interface GenerateSafeCoachingDeps {
  readonly coach: AiCoachPort;
  readonly audit: AiAuditSinkPort;
  readonly policy: ContentSafetyPolicy;
  /** AI 提案の公開 feature flag。false なら provider を呼ばず fallback。 */
  readonly publicationEnabled: boolean;
  readonly config: GenerateSafeCoachingConfig;
  readonly sleep: (ms: number) => Promise<void>;
  /** [0, 1) の乱数(backoff の jitter)。 */
  readonly random: () => number;
  /** 差し替え可能な validator(例外時の fail-closed を検証するため)。既定は `validateGeneratedContent`。 */
  readonly validator?: (
    texts: readonly string[],
    policy: ContentSafetyPolicy,
  ) => ContentSafetyAssessment;
}

interface ResultBase {
  readonly purpose: AiPurpose;
  readonly schemaVersion: string;
  readonly promptVersion: string;
  readonly attempts: number;
}

/** `source: "ai"` は検証に `pass` した本文のときだけ。それ以外の本文は決して返さない(AIC-INV-001)。 */
export type SafeCoachingResult<T> =
  | (ResultBase & {
      readonly source: "ai";
      readonly output: T;
      readonly model: string;
      readonly contentSafety: {
        readonly status: "pass";
        readonly reasonCodes: readonly [];
        readonly validatorVersion: string;
        readonly fallbackVersion: null;
      };
    })
  | (ResultBase & {
      readonly source: "fallback";
      readonly output: T;
      readonly fallbackReason: FallbackReason;
      readonly contentSafety: {
        readonly status: "fallback" | "required_human_review";
        readonly reasonCodes: readonly ContentSafetyReasonCode[];
        readonly validatorVersion: string;
        readonly fallbackVersion: string;
      };
    });

type ProviderOutcome =
  | { readonly kind: "completed"; readonly rawOutput: unknown; readonly model: string }
  | { readonly kind: "refusal" }
  | { readonly kind: "failed" };

/** 契約 schema(zod)が満たす最小の構造。Application は検証ライブラリに直接依存しない。 */
interface OutputSchema<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

interface Pipeline<T> {
  readonly request: AiCoachRequest;
  readonly schema: OutputSchema<T>;
  readonly buildFallback: () => T;
  /** ユーザーが明示入力した自由記述(事前検査の対象)。 */
  readonly userTexts: readonly string[];
}

function backoffMs(deps: GenerateSafeCoachingDeps, attempt: number): number {
  const { baseBackoffMs, maxBackoffMs } = deps.config;
  const ceiling = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (attempt - 1));
  return Math.floor(deps.random() * ceiling); // full jitter
}

async function callOnce(
  deps: GenerateSafeCoachingDeps,
  request: AiCoachRequest,
): Promise<Extract<ProviderOutcome, { kind: "completed" | "refusal" }>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiCoachProviderError("timeout"));
    }, deps.config.attemptTimeoutMs);
  });
  try {
    const result = await Promise.race([
      deps.coach.generate({
        ...request,
        promptVersion: deps.config.promptVersion,
        systemPolicy: COACHING_SYSTEM_POLICY_V1,
        signal: controller.signal,
      }),
      timeout,
    ]);
    return result.outcome === "refusal"
      ? { kind: "refusal" }
      : { kind: "completed", rawOutput: result.rawOutput, model: result.model };
  } finally {
    clearTimeout(timer);
  }
}

/** 一時的障害だけを backoff + jitter で再試行する。使った attempt 数も返す。 */
async function callWithRetry(
  deps: GenerateSafeCoachingDeps,
  request: AiCoachRequest,
  attemptsSoFar: number,
): Promise<{ outcome: ProviderOutcome; attempts: number }> {
  let attempts = attemptsSoFar;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    attempts += 1;
    try {
      return { outcome: await callOnce(deps, request), attempts };
    } catch (error) {
      const retryable =
        error instanceof AiCoachProviderError &&
        RETRYABLE_PROVIDER_ERROR_KINDS.includes(error.kind);
      if (!retryable || attempt === MAX_PROVIDER_ATTEMPTS) {
        return { outcome: { kind: "failed" }, attempts };
      }
      await deps.sleep(backoffMs(deps, attempt));
    }
  }
  return { outcome: { kind: "failed" }, attempts };
}

async function recordAudit(
  deps: GenerateSafeCoachingDeps,
  result: SafeCoachingResult<unknown>,
): Promise<void> {
  try {
    await deps.audit.record({
      kind: "generation",
      purpose: result.purpose,
      source: result.source,
      status: result.contentSafety.status,
      reasonCodes: result.contentSafety.reasonCodes,
      fallbackReason: result.source === "fallback" ? result.fallbackReason : null,
      schemaVersion: result.schemaVersion,
      promptVersion: result.promptVersion,
      validatorVersion: result.contentSafety.validatorVersion,
      fallbackVersion: result.contentSafety.fallbackVersion,
      attempts: result.attempts,
    });
  } catch {
    // 監査の失敗で結果の返却(fail closed 済み)を妨げない。原因の詳細を残さない。
  }
}

async function run<T>(
  deps: GenerateSafeCoachingDeps,
  pipeline: Pipeline<T>,
): Promise<SafeCoachingResult<T>> {
  const base = {
    purpose: pipeline.request.purpose,
    schemaVersion: AI_SCHEMA_VERSION,
    promptVersion: deps.config.promptVersion,
  };
  let attempts = 0;

  const fallback = (
    fallbackReason: FallbackReason,
    status: "fallback" | "required_human_review" = "fallback",
    reasonCodes: readonly ContentSafetyReasonCode[] = [],
  ): SafeCoachingResult<T> => ({
    ...base,
    attempts,
    source: "fallback",
    output: pipeline.buildFallback(),
    fallbackReason,
    contentSafety: {
      status,
      reasonCodes,
      validatorVersion: CONTENT_VALIDATOR_VERSION,
      fallbackVersion: SAFE_FALLBACK_VERSION,
    },
  });

  const finish = async (result: SafeCoachingResult<T>): Promise<SafeCoachingResult<T>> => {
    await recordAudit(deps, result);
    return result;
  };

  if (!deps.publicationEnabled) return finish(fallback("disabled"));

  const requestReasons = inspectGenerationRequest(pipeline.userTexts);
  if (requestReasons.length > 0)
    return finish(fallback("input_rejected", "fallback", requestReasons));

  const validator = deps.validator ?? validateGeneratedContent;
  let rejected: ContentSafetyAssessment | null = null;

  for (let generation = 0; generation <= MAX_REGENERATIONS; generation += 1) {
    const called = await callWithRetry(deps, pipeline.request, attempts);
    attempts = called.attempts;
    if (called.outcome.kind === "failed") return finish(fallback("provider_unavailable"));
    if (called.outcome.kind === "refusal") return finish(fallback("provider_refusal"));

    let assessment: ContentSafetyAssessment;
    let output: T;
    try {
      const parsed = pipeline.schema.safeParse(called.outcome.rawOutput);
      if (!parsed.success) return finish(fallback("invalid_output"));
      output = parsed.data;
      assessment = validator(collectStrings(output), deps.policy);
    } catch {
      return finish(fallback("validator_error"));
    }

    if (assessment.status === "pass") {
      return finish({
        ...base,
        attempts,
        source: "ai",
        output,
        model: called.outcome.model,
        contentSafety: {
          status: "pass",
          reasonCodes: [],
          validatorVersion: assessment.validatorVersion,
          fallbackVersion: null,
        },
      });
    }
    rejected = assessment;
  }

  return finish(
    fallback(
      "safety_rejected",
      rejected?.status === "required_human_review" ? "required_human_review" : "fallback",
      rejected?.reasonCodes ?? [],
    ),
  );
}

type HabitDesignRequest = Extract<AiCoachRequest, { purpose: "habit_design" }>;
type WeeklyImprovementRequest = Extract<AiCoachRequest, { purpose: "weekly_improvement" }>;

/**
 * AI 提案の唯一の入口(docs/specs/ai-contracts.md AIC-003)。T-303〜T-305 はこの関数を必ず経由する。
 * 戻り値の本文は `source: "ai"`(validator `pass`)か、独自の定型 fallback のいずれか。
 * 例外・timeout・設定欠損でも未検証本文を返さない(fail closed)。
 */
export function generateSafeCoaching(
  deps: GenerateSafeCoachingDeps,
  request: HabitDesignRequest,
): Promise<SafeCoachingResult<HabitDesignProposalV1>>;
export function generateSafeCoaching(
  deps: GenerateSafeCoachingDeps,
  request: WeeklyImprovementRequest,
): Promise<SafeCoachingResult<WeeklyImprovementPlanV1>>;
export function generateSafeCoaching(
  deps: GenerateSafeCoachingDeps,
  request: AiCoachRequest,
): Promise<
  SafeCoachingResult<HabitDesignProposalV1> | SafeCoachingResult<WeeklyImprovementPlanV1>
> {
  switch (request.purpose) {
    case "habit_design": {
      const { input } = request;
      return run(deps, {
        request,
        schema: habitDesignProposalV1Schema,
        buildFallback: () => buildHabitDesignFallback(input),
        userTexts: [input.goal, ...(input.constraints === null ? [] : [input.constraints])],
      });
    }
    case "weekly_improvement": {
      const { input } = request;
      return run(deps, {
        request,
        schema: weeklyImprovementPlanV1Schema,
        buildFallback: buildWeeklyImprovementFallback,
        userTexts: input.reflection === null ? [] : [input.reflection],
      });
    }
    default: {
      const unreachable: never = request;
      return unreachable;
    }
  }
}
