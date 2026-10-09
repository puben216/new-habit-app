import { WEEKLY_IMPROVEMENT_PROMPT_VERSION } from "@habit-app/application";
import type { AiJobConfig, AiCoachPort, Clock, ProcessAiJobDeps } from "@habit-app/application";
import type { PrismaClient } from "../generated/prisma/client";
import { createPrismaHabitRepository } from "../habits/prisma-habit-repository";
import { createPrismaWeeklyReviewRepository } from "../tracking/prisma-weekly-review-repository";
import { FAKE_AI_MODEL, createFakeAiCoach } from "./fake-ai-coach";
import { createNoopAiAuditSink } from "./noop-ai-audit-sink";
import { createPrismaAiJobRepository } from "./prisma-ai-job-repository";

/**
 * AI job の composition 補助(apps/web の inline queue と apps/workers の Lambda が同じ配線を使う)。
 * 環境変数の解釈は呼び出し側(composition root)で行い、ここでは解釈済みの値だけを受け取る。
 */
export interface AiJobWiringOptions {
  /** 現在は fake のみ(ADR-003 の確定後に実 provider を追加する)。 */
  readonly provider: "fake";
  /** AI 提案の公開 feature flag。false の間は provider を呼ばず定型 fallback で完結する。 */
  readonly publicationEnabled: boolean;
  readonly now?: Clock | undefined;
}

/** `ai_jobs.provider` / 実行前の `model` に保存する設定値。 */
export function aiJobConfigFor(provider: AiJobWiringOptions["provider"]): AiJobConfig {
  switch (provider) {
    case "fake":
      return {
        promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
        provider: "fake",
        model: FAKE_AI_MODEL,
      };
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function createCoach(provider: AiJobWiringOptions["provider"]): AiCoachPort {
  switch (provider) {
    case "fake":
      return createFakeAiCoach();
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

/** worker(`processAiJobUseCase`/`handleAiJobMessages`)の依存を組み立てる。 */
export function createAiJobProcessDeps(
  prisma: PrismaClient,
  options: AiJobWiringOptions,
): ProcessAiJobDeps {
  return {
    reviewRepository: createPrismaWeeklyReviewRepository(prisma),
    habitRepository: createPrismaHabitRepository(prisma),
    jobRepository: createPrismaAiJobRepository(prisma),
    now: options.now ?? (() => new Date()),
    generate: {
      coach: createCoach(options.provider),
      audit: createNoopAiAuditSink(),
      // 管理対象の第三者名称・参照 excerpt は権利資料 allowlist(T-505)から注入する。それまでは空。
      policy: { managedTerms: [], referenceExcerpts: [] },
      publicationEnabled: options.publicationEnabled,
      config: {
        promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
        attemptTimeoutMs: 20_000,
        baseBackoffMs: 500,
        maxBackoffMs: 5_000,
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
    },
  };
}
