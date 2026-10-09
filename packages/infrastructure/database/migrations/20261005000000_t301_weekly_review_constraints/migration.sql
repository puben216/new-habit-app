-- T-301 Weekly review (docs/specs/weekly-review.md Data and Migration)
-- expand(後方互換): weekly_reviews の整合性を DB でも強制する CHECK 制約を追加する。
-- weekly_reviews は T-301 以前にアプリが書き込んでおらず既存行がない前提のため backfill は不要。
-- 適用前に `SELECT count(*) FROM weekly_reviews` が 0 であることを確認する(0 でなければ制約違反で失敗する)。

-- AddCheckConstraint
ALTER TABLE "weekly_reviews"
  -- status と completed_at は常に同値(WREV-INV-006)
  ADD CONSTRAINT "weekly_reviews_completed_at_check"
    CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL)),
  -- 振り返りの長さ(空文字は null として保存するため 1 文字以上)。Domain の WEEKLY_REVIEW_REFLECTION_MAX_LENGTH と同じ値
  ADD CONSTRAINT "weekly_reviews_reflection_length_check"
    CHECK ("reflection" IS NULL OR char_length("reflection") BETWEEN 1 AND 1000),
  ADD CONSTRAINT "weekly_reviews_timezone_check"
    CHECK (char_length("timezone_snapshot") BETWEEN 1 AND 64),
  -- スナップショットは JSON オブジェクト(形の検証は読み出し時に schemaVersion ごとの schema で行う)
  ADD CONSTRAINT "weekly_reviews_summary_object_check"
    CHECK (jsonb_typeof("summary_json") = 'object');
