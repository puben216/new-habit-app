-- T-102 User/Profile (docs/specs/user-profile.md Data and Migration)
-- expand(後方互換): display_name を nullable 化し(未設定を NULL で表す)、値域の CHECK 制約を追加する。
-- user_profiles は T-102 以前にアプリが書き込んでおらず既存行がない前提のため backfill は不要。

-- AlterTable
ALTER TABLE "user_profiles" ALTER COLUMN "display_name" DROP NOT NULL;

-- AddCheckConstraints
ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_display_name_length_check"
    CHECK ("display_name" IS NULL OR char_length("display_name") BETWEEN 1 AND 50),
  ADD CONSTRAINT "user_profiles_timezone_length_check"
    CHECK (char_length("timezone") BETWEEN 1 AND 64),
  ADD CONSTRAINT "user_profiles_locale_check"
    CHECK ("locale" IN ('ja', 'en')),
  ADD CONSTRAINT "user_profiles_week_starts_on_check"
    CHECK ("week_starts_on" BETWEEN 0 AND 6);
