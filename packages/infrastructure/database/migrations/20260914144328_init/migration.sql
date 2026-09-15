-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "auth_subject" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" BIGINT NOT NULL,
    "display_name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "week_starts_on" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "habits" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "cue" TEXT NOT NULL,
    "minimum_action" TEXT NOT NULL,
    "replacement_action" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "habits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "habit_schedule_versions" (
    "id" BIGSERIAL NOT NULL,
    "habit_id" BIGINT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "days_of_week" INTEGER[],
    "local_time" TIME,
    "target_count" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "habit_schedule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "habit_entries" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "habit_id" BIGINT NOT NULL,
    "habit_date" DATE NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "quantity" DECIMAL(65,30),
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "habit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_check_ins" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "check_in_date" DATE NOT NULL,
    "mood" SMALLINT,
    "difficulty" SMALLINT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_reviews" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "week_start" DATE NOT NULL,
    "timezone_snapshot" TEXT NOT NULL,
    "summary_json" JSONB NOT NULL,
    "reflection" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_public_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "prompt_version" TEXT NOT NULL,
    "output_schema_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_fingerprint" TEXT NOT NULL,
    "result_json" JSONB,
    "failure_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_job_attempts" (
    "id" BIGSERIAL NOT NULL,
    "ai_job_id" BIGINT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider_request_id" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "estimated_cost" DECIMAL(65,30),
    "error_category" TEXT,

    CONSTRAINT "ai_job_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "habit_id" BIGINT,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "local_time" TIME NOT NULL,
    "timezone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours_start" TIME,
    "quiet_hours_end" TIME,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "notification_setting_id" BIGINT NOT NULL,
    "deduplication_key" TEXT NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(6),
    "failure_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_code" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_public_id" UUID,
    "request_id" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_public_id_key" ON "users"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_subject_key" ON "users"("auth_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_normalized_key" ON "users"("email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "habits_public_id_key" ON "habits"("public_id");

-- CreateIndex
CREATE INDEX "habits_user_id_status_created_at_id_idx" ON "habits"("user_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "habit_schedule_versions_habit_id_effective_from_key" ON "habit_schedule_versions"("habit_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "habit_entries_public_id_key" ON "habit_entries"("public_id");

-- CreateIndex
CREATE INDEX "habit_entries_user_id_habit_date_id_idx" ON "habit_entries"("user_id", "habit_date" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "habit_entries_habit_id_habit_date_key" ON "habit_entries"("habit_id", "habit_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_check_ins_user_id_check_in_date_key" ON "daily_check_ins"("user_id", "check_in_date");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_reviews_public_id_key" ON "weekly_reviews"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_reviews_user_id_week_start_key" ON "weekly_reviews"("user_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "ai_jobs_public_id_key" ON "ai_jobs"("public_id");

-- CreateIndex
CREATE INDEX "ai_jobs_user_id_idx" ON "ai_jobs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_job_attempts_ai_job_id_attempt_no_key" ON "ai_job_attempts"("ai_job_id", "attempt_no");

-- CreateIndex
CREATE INDEX "notification_settings_user_id_idx" ON "notification_settings"("user_id");

-- CreateIndex
CREATE INDEX "notification_settings_habit_id_idx" ON "notification_settings"("habit_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_deduplication_key_key" ON "notification_deliveries"("deduplication_key");

-- CreateIndex
CREATE INDEX "notification_deliveries_notification_setting_id_idx" ON "notification_deliveries"("notification_setting_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_scope_key_key" ON "idempotency_keys"("user_id", "scope", "key");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habits" ADD CONSTRAINT "habits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habit_schedule_versions" ADD CONSTRAINT "habit_schedule_versions_habit_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "habits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habit_entries" ADD CONSTRAINT "habit_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habit_entries" ADD CONSTRAINT "habit_entries_habit_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "habits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_check_ins" ADD CONSTRAINT "daily_check_ins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_job_attempts" ADD CONSTRAINT "ai_job_attempts_ai_job_id_fkey" FOREIGN KEY ("ai_job_id") REFERENCES "ai_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_habit_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "habits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_setting_id_fkey" FOREIGN KEY ("notification_setting_id") REFERENCES "notification_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint: 状態値はtext + CHECKとして扱う(04-database-design.mdの方針)
ALTER TABLE "users" ADD CONSTRAINT "users_status_check"
  CHECK ("status" IN ('active', 'suspended', 'deletion_pending'));

ALTER TABLE "habits" ADD CONSTRAINT "habits_kind_check"
  CHECK ("kind" IN ('build', 'reduce'));

ALTER TABLE "habits" ADD CONSTRAINT "habits_status_check"
  CHECK ("status" IN ('active', 'archived'));

ALTER TABLE "habit_entries" ADD CONSTRAINT "habit_entries_status_check"
  CHECK ("status" IN ('success', 'missed', 'skipped'));

ALTER TABLE "habit_entries" ADD CONSTRAINT "habit_entries_source_check"
  CHECK ("source" IN ('web', 'system'));

ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_status_check"
  CHECK ("status" IN ('draft', 'completed'));

ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_status_check"
  CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'fallback'));

-- CheckConstraint: mood/difficultyは1〜5(daily_check_ins)
ALTER TABLE "daily_check_ins" ADD CONSTRAINT "daily_check_ins_mood_check"
  CHECK ("mood" IS NULL OR "mood" BETWEEN 1 AND 5);

ALTER TABLE "daily_check_ins" ADD CONSTRAINT "daily_check_ins_difficulty_check"
  CHECK ("difficulty" IS NULL OR "difficulty" BETWEEN 1 AND 5);

-- CheckConstraint: habit_schedule_versions(04-database-design.mdの制約)
-- reduceのtarget_count=1固定はhabits.kindを跨ぐためDB triggerにせずApplication層で検証する。
ALTER TABLE "habit_schedule_versions" ADD CONSTRAINT "habit_schedule_versions_target_count_check"
  CHECK ("target_count" > 0);

ALTER TABLE "habit_schedule_versions" ADD CONSTRAINT "habit_schedule_versions_days_of_week_check"
  CHECK (
    array_length("days_of_week", 1) > 0
    AND "days_of_week" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
  );

-- ExclusionConstraint: 同一habitのスケジュール有効期間重複を禁止する。
-- effective_toがNULLの場合はdaterangeの無限大端として扱われ、以降すべてと重複判定される。
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "habit_schedule_versions" ADD CONSTRAINT "habit_schedule_versions_no_overlap"
  EXCLUDE USING gist (
    "habit_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  );

-- Trigger: updated_atはPrisma Clientが@updatedAtでも設定するが、
-- 生SQLや管理ツール経由の更新でも一貫させるためDB側でも保証する。
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "user_profiles"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "habits"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "habit_schedule_versions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "habit_entries"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "daily_check_ins"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "weekly_reviews"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "ai_jobs"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "notification_settings"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "notification_deliveries"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "idempotency_keys"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
