export { admitCorpusSource } from "./corpus";
export type { AdmitCorpusSourceDeps, AdmitCorpusSourceResult } from "./corpus";
export {
  CONTENT_VALIDATOR_VERSION,
  LONG_QUOTATION_MIN_CHARS,
  SOURCE_OVERLAP_MIN_CHARS,
  inspectGenerationRequest,
  validateGeneratedContent,
} from "./content-validator";
export type { ContentSafetyAssessment, ContentSafetyPolicy } from "./content-validator";
export {
  SAFE_FALLBACK_VERSION,
  buildHabitDesignFallback,
  buildWeeklyImprovementFallback,
} from "./fallback";
export {
  MAX_PROVIDER_ATTEMPTS,
  MAX_REGENERATIONS,
  generateSafeCoaching,
} from "./generate-safe-coaching";
export type {
  GenerateSafeCoachingConfig,
  GenerateSafeCoachingDeps,
  SafeCoachingResult,
} from "./generate-safe-coaching";
export { COACHING_SYSTEM_POLICY_V1, COACHING_SYSTEM_POLICY_VERSION } from "./policy";
export {
  AI_PROVIDER_ERROR_KINDS,
  AiCoachProviderError,
  FALLBACK_REASONS,
  RETRYABLE_PROVIDER_ERROR_KINDS,
} from "./ports";
export type {
  AiAuditEvent,
  AiAuditSinkPort,
  AiCoachGenerateParams,
  AiCoachGenerateResult,
  AiCoachPort,
  AiCoachProviderErrorKind,
  AiCoachRequest,
  FallbackReason,
  ThirdPartyRightsRegistryPort,
} from "./ports";
