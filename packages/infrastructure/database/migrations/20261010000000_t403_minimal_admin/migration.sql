-- T-403 Minimal admin (docs/specs/minimal-admin.md データとMigration)
-- expand(後方互換): 管理者アカウント、リカバリーコード、session の MFA 検証時刻を追加し、
-- audit_logs を追記専用にする。T-403 以前にアプリが audit_logs へ書き込んでおらず既存行がない前提。

-- AlterTable: 既存の session は MFA 未検証(NULL)のまま。
ALTER TABLE "sessions" ADD COLUMN "mfa_verified_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "totp_secret_enc" TEXT NOT NULL,
    "totp_last_step" BIGINT,
    "mfa_failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "mfa_locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_users_status_check" CHECK ("status" IN ('active', 'disabled')),
    CONSTRAINT "admin_users_mfa_failed_attempts_check" CHECK ("mfa_failed_attempts" >= 0)
);

-- CreateIndex: 1 ユーザー 1 管理者(FK user_id の index も兼ねる)
CREATE UNIQUE INDEX "admin_users_public_id_key" ON "admin_users"("public_id");
CREATE UNIQUE INDEX "admin_users_user_id_key" ON "admin_users"("user_id");

-- AddForeignKey
ALTER TABLE "admin_users"
  ADD CONSTRAINT "admin_users_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "admin_users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CreateTable: リカバリーコード(ハッシュのみ。単回使用)
CREATE TABLE "admin_recovery_codes" (
    "id" BIGSERIAL NOT NULL,
    "admin_user_id" BIGINT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_recovery_codes_code_hash_key" ON "admin_recovery_codes"("code_hash");
CREATE INDEX "admin_recovery_codes_admin_user_id_idx" ON "admin_recovery_codes"("admin_user_id");

ALTER TABLE "admin_recovery_codes"
  ADD CONSTRAINT "admin_recovery_codes_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- audit_logs: 追記専用(UPDATE / DELETE / TRUNCATE を拒否)。多層防御であり、本番の実際の境界は
-- runtime role に INSERT / SELECT のみを与える権限設定(共通基盤 T-501 / T-502)。
-- ユーザー削除時の匿名化・保持期間の保守は T-404 が専用の Migration で扱う。
CREATE FUNCTION audit_logs_reject_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_modification();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_modification();

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_actor_check" CHECK (char_length("actor") > 0),
  ADD CONSTRAINT "audit_logs_action_check" CHECK (char_length("action") > 0);

-- CreateIndex: 監査のレビュー(actor 別・時系列)
CREATE INDEX "audit_logs_actor_created_at_idx" ON "audit_logs" ("actor", "created_at" DESC);
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" ("created_at" DESC, "id" DESC);
