-- T-402 Notification scheduler/delivery (docs/specs/notification-delivery.md データとMigration)
-- expand(後方互換): 配送の実行に必要な列・制約・index、suppression テーブルを追加する。
-- notification_deliveries は T-402 以前にアプリが書き込んでおらず既存行がない前提のため、
-- NOT NULL 列を既定値なしで追加でき、backfill は不要。

-- AlterTable
ALTER TABLE "notification_deliveries"
  ADD COLUMN "user_id" BIGINT NOT NULL,
  ADD COLUMN "local_date" DATE NOT NULL,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,
  ADD COLUMN "enqueued_at" TIMESTAMPTZ(6),
  ADD COLUMN "locked_until" TIMESTAMPTZ(6);

-- AddForeignKey
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint: 状態値は text + CHECK(04-database-design.md の方針)
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_status_check"
    CHECK ("status" IN ('pending', 'sent', 'skipped', 'expired', 'suppressed', 'failed')),
  ADD CONSTRAINT "notification_deliveries_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 5);

-- CreateIndex: FK user_id 用
CREATE INDEX "notification_deliveries_user_id_idx" ON "notification_deliveries"("user_id");

-- CreateIndex: 再投入の走査(pending のみ)
CREATE INDEX "notification_deliveries_pending_next_attempt_idx"
  ON "notification_deliveries" ("next_attempt_at")
  WHERE "status" = 'pending';

-- CreateIndex: bounce/complaint の引き当て(SES の message ID は一意)
CREATE UNIQUE INDEX "notification_deliveries_provider_message_id_uidx"
  ON "notification_deliveries" ("provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;

-- CreateIndex: スケジューラの設定走査(有効なユーザー単位の email 設定のみ)
CREATE INDEX "notification_settings_enabled_scan_idx"
  ON "notification_settings" ("id")
  WHERE "enabled" AND "habit_id" IS NULL AND "channel" = 'email';

-- CreateTable: hard bounce / complaint を受けたユーザーへは設定に関わらず送らない
CREATE TABLE "email_suppressions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_suppressions_reason_check" CHECK ("reason" IN ('bounce', 'complaint'))
);

-- CreateIndex: 1 ユーザー 1 件(FK user_id の index も兼ねる)
CREATE UNIQUE INDEX "email_suppressions_user_id_key" ON "email_suppressions"("user_id");

-- AddForeignKey
ALTER TABLE "email_suppressions"
  ADD CONSTRAINT "email_suppressions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
