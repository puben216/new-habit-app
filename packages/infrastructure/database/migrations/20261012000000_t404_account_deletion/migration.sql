-- T-404 アカウント削除 (docs/specs/account-deletion.md データとMigration)
-- expand(後方互換): 削除予約の状態整合、期限スキャン用の部分 index、再認証の試行種別を追加する。
-- users.deleted_at を書く既存コードはなく deletion_pending の行もないため、backfill は不要。

-- ACD-INV-002: deletion_pending と deleted_at の有無は同値(状態の変更は条件付き更新の単一文で行う)。
ALTER TABLE "users"
  ADD CONSTRAINT "users_deletion_state_check"
    CHECK (("status" = 'deletion_pending') = ("deleted_at" IS NOT NULL));

-- 削除ジョブの期限スキャン: WHERE status = 'deletion_pending' AND deleted_at <= ? ORDER BY deleted_at
CREATE INDEX "users_deletion_pending_deleted_at_idx"
  ON "users" ("deleted_at")
  WHERE "status" = 'deletion_pending';

-- ACD-001: 再認証の試行を通常のログインと独立して制限するため、purpose に 'reauth' を加える(値の追加のみ)。
ALTER TABLE "login_attempts" DROP CONSTRAINT "login_attempts_purpose_check";
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_purpose_check"
  CHECK ("purpose" IN ('signup', 'login', 'verify_resend', 'password_reset', 'reauth'));
