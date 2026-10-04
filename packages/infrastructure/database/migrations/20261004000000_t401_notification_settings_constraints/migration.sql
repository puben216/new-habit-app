-- T-401 Notification preferences (docs/specs/notification-preferences.md Data and Migration)
-- expand(後方互換): ユーザー単位の通知設定の一意性と値域の CHECK を追加する。
-- notification_settings は T-401 以前にアプリが書き込んでおらず既存行がない前提のため backfill は不要。

-- ユーザー単位(habit_id IS NULL)の設定は 1 ユーザー 1 行。upsert の ON CONFLICT arbiter でもある。
CREATE UNIQUE INDEX "notification_settings_user_default_uidx"
  ON "notification_settings" ("user_id")
  WHERE "habit_id" IS NULL;

-- AddCheckConstraint
ALTER TABLE "notification_settings"
  ADD CONSTRAINT "notification_settings_channel_check"
    CHECK ("channel" = 'email'),
  ADD CONSTRAINT "notification_settings_quiet_hours_pair_check"
    CHECK (("quiet_hours_start" IS NULL) = ("quiet_hours_end" IS NULL)),
  ADD CONSTRAINT "notification_settings_quiet_hours_distinct_check"
    CHECK ("quiet_hours_start" IS NULL OR "quiet_hours_start" <> "quiet_hours_end"),
  ADD CONSTRAINT "notification_settings_timezone_check"
    CHECK (char_length("timezone") BETWEEN 1 AND 64);
