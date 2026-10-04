import {
  AiCoachProviderError,
  type AiCoachGenerateParams,
  type AiCoachGenerateResult,
  type AiCoachPort,
  type AiCoachProviderErrorKind,
} from "@habit-app/application";

/**
 * テスト・ローカル・T-303 の E2E 用の fake provider(docs/specs/ai-contracts.md AIC-002)。
 * 外部通信をしない。本番の composition root では使用しない。
 */
export type FakeAiCoachStep =
  | { readonly kind: "completed"; readonly rawOutput: unknown; readonly model?: string }
  | { readonly kind: "refusal" }
  | { readonly kind: "error"; readonly errorKind: AiCoachProviderErrorKind }
  /** 呼び出しが完了せず、`signal` の abort で初めて終了する(timeout の検証用)。 */
  | { readonly kind: "hang" };

export interface FakeAiCoach extends AiCoachPort {
  /** 受け取った引数の記録(入力が最小化されているかの検証用)。 */
  readonly calls: readonly AiCoachGenerateParams[];
}

export const FAKE_AI_MODEL = "fake-model-1";

function defaultRawOutput(params: AiCoachGenerateParams): unknown {
  const safety = { requiresHumanSupport: false, message: null };
  if (params.purpose === "habit_design") {
    return {
      schemaVersion: "1",
      summary: "小さく始められる案です。",
      habit: {
        kind: params.input.habitKind,
        name: "朝の短い読書",
        purpose: "学びを日常に取り入れる",
        cue: "朝食を食べ終えたら",
        minimumAction: "1ページだけ読む",
      },
      rationale: "最小の行動なら忙しい日でも続けやすくなります。",
      safety,
    };
  }
  return {
    schemaVersion: "1",
    summary: "今週は記録の習慣が少しずつ整ってきました。",
    observations: [
      {
        evidence: "今週の予定のうち半分以上を実施",
        interpretation: "流れができ始めている可能性があります",
      },
    ],
    suggestions: [
      {
        title: "最小行動を小さくする",
        rationale: "難しい日にも取り組みやすくするため",
        changeType: "minimum_action",
        proposedValue: "1分だけ取り組む",
        confidence: "medium",
      },
    ],
    safety,
  };
}

/** `script` を呼び出し順に消費し、尽きたら purpose に応じた有効な出力を返す。 */
export function createFakeAiCoach(script: readonly FakeAiCoachStep[] = []): FakeAiCoach {
  const calls: AiCoachGenerateParams[] = [];
  let index = 0;

  return {
    calls,
    async generate(params): Promise<AiCoachGenerateResult> {
      calls.push(params);
      const step = script[index];
      index += 1;
      if (step === undefined) {
        return { outcome: "completed", rawOutput: defaultRawOutput(params), model: FAKE_AI_MODEL };
      }
      switch (step.kind) {
        case "completed":
          return {
            outcome: "completed",
            rawOutput: step.rawOutput,
            model: step.model ?? FAKE_AI_MODEL,
          };
        case "refusal":
          return { outcome: "refusal" };
        case "error":
          throw new AiCoachProviderError(step.errorKind);
        case "hang":
          return new Promise<never>((_, reject) => {
            params.signal.addEventListener(
              "abort",
              () => reject(new AiCoachProviderError("timeout")),
              {
                once: true,
              },
            );
          });
        default: {
          const unreachable: never = step;
          return unreachable;
        }
      }
    },
  };
}
