-- T-202 Habit entry (docs/specs/habit-entry.md Data and Migration)
-- expand(後方互換): habit_entries.quantity の値域 CHECK を追加する。
-- habit_entries は T-202 以前にアプリが書き込んでおらず既存行がない前提のため backfill は不要。

-- AddCheckConstraint
ALTER TABLE "habit_entries"
  ADD CONSTRAINT "habit_entries_quantity_check"
    CHECK ("quantity" IS NULL OR ("quantity" >= 0 AND "quantity" <= 1000));
