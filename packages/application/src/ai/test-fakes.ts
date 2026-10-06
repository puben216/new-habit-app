import type {
  AiAuditEvent,
  AiCoachGenerateParams,
  AiCoachGenerateResult,
  AiCoachPort,
} from "./ports";
import type { GenerateSafeCoachingDeps } from "./generate-safe-coaching";
import { POLICY } from "./fixtures";

export type Step = AiCoachGenerateResult | Error | "hang";

/** 台本どおりに応答する provider。尽きたら最後の step を繰り返す。 */
export function createScriptedCoach(steps: readonly Step[]): AiCoachPort & {
  readonly calls: AiCoachGenerateParams[];
} {
  const calls: AiCoachGenerateParams[] = [];
  return {
    calls,
    async generate(params) {
      calls.push(params);
      const step = steps[Math.min(calls.length, steps.length) - 1];
      if (step === undefined) throw new Error("empty script");
      if (step === "hang") {
        return new Promise<never>(() => undefined);
      }
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

export function createDeps(
  coach: AiCoachPort,
  overrides: Partial<GenerateSafeCoachingDeps> = {},
): {
  deps: GenerateSafeCoachingDeps;
  events: AiAuditEvent[];
  sleeps: number[];
} {
  const events: AiAuditEvent[] = [];
  const sleeps: number[] = [];
  const deps: GenerateSafeCoachingDeps = {
    coach,
    audit: { record: async (event) => void events.push(event) },
    policy: POLICY,
    publicationEnabled: true,
    config: {
      promptVersion: "prompt-test/1",
      attemptTimeoutMs: 50,
      baseBackoffMs: 100,
      maxBackoffMs: 1000,
    },
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...overrides,
  };
  return { deps, events, sleeps };
}

export function completed(rawOutput: unknown): AiCoachGenerateResult {
  return { outcome: "completed", rawOutput, model: "fake-model" };
}
