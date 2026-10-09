-- T-303 AI queue pipeline (docs/specs/ai-queue-pipeline.md Data and Migration)
-- expand(後方互換): ai_jobs の冪等な作成と整合性を DB でも強制する制約を追加する。
-- ai_jobs / ai_job_attempts は T-303 以前にアプリが書き込んでおらず既存行がない前提のため backfill は不要。
-- 適用前に `SELECT count(*) FROM ai_jobs` が 0 であることを確認する(0 でなければ制約違反で失敗しうる)。

-- 冪等な作成の arbiter: 同じ (user, kind, subject, prompt version, 入力 fingerprint) の job は 1 件(AJOB-INV-002)
CREATE UNIQUE INDEX "ai_jobs_idempotency_uidx"
  ON "ai_jobs" ("user_id", "kind", "subject_public_id", "prompt_version", "input_fingerprint");

-- AddCheckConstraint
ALTER TABLE "ai_jobs"
  ADD CONSTRAINT "ai_jobs_kind_check"
    CHECK ("kind" IN ('weekly_improvement', 'habit_design')),
  -- succeeded/fallback ⇔ result_json あり、かつ object(AJOB-INV-005)
  ADD CONSTRAINT "ai_jobs_result_check"
    CHECK (
      ("status" IN ('succeeded', 'fallback')) = ("result_json" IS NOT NULL)
      AND ("result_json" IS NULL OR jsonb_typeof("result_json") = 'object')
    ),
  -- failed ⇒ failure_code あり
  ADD CONSTRAINT "ai_jobs_failure_code_check"
    CHECK ("status" <> 'failed' OR "failure_code" IS NOT NULL);

ALTER TABLE "ai_job_attempts"
  ADD CONSTRAINT "ai_job_attempts_attempt_no_check" CHECK ("attempt_no" >= 1),
  ADD CONSTRAINT "ai_job_attempts_outcome_check"
    CHECK ("outcome" IN ('succeeded', 'fallback', 'failed', 'error')),
  ADD CONSTRAINT "ai_job_attempts_latency_check"
    CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0);
