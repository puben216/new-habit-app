import { describe, expect, it } from "vitest";

import {
  ACCOUNT_FIELDS,
  AI_RESULT_FIELDS,
  DAILY_CHECK_IN_FIELDS,
  HABIT_ENTRY_FIELDS,
  HABIT_FIELDS,
  NOTIFICATION_SETTINGS_FIELDS,
  PROFILE_FIELDS,
  SCHEDULE_VERSION_FIELDS,
  WEEKLY_REVIEW_FIELDS,
  pickFields,
} from "./bundle";

/**
 * Spec「出力するデータ」の表と、実装の許可リストを一致させる(EXP-INV-002)。
 * ここを変えるときは Spec・契約(schemaVersion)・テストを一緒に更新する。
 */
describe("許可リスト(Spec「出力するデータ」と一致)", () => {
  it("項目の集合が Spec の表と一致する", () => {
    expect([...ACCOUNT_FIELDS]).toEqual(["email", "createdAt"]);
    expect([...PROFILE_FIELDS]).toEqual(["displayName", "timezone", "locale", "weekStartsOn"]);
    expect([...HABIT_FIELDS]).toEqual([
      "id",
      "kind",
      "name",
      "purpose",
      "cue",
      "minimumAction",
      "replacementAction",
      "status",
      "createdAt",
      "updatedAt",
    ]);
    expect([...SCHEDULE_VERSION_FIELDS]).toEqual([
      "habitId",
      "effectiveFrom",
      "effectiveTo",
      "daysOfWeek",
      "targetCount",
    ]);
    expect([...HABIT_ENTRY_FIELDS]).toEqual([
      "id",
      "habitId",
      "date",
      "status",
      "quantity",
      "note",
      "source",
      "createdAt",
      "updatedAt",
    ]);
    expect([...DAILY_CHECK_IN_FIELDS]).toEqual([
      "date",
      "mood",
      "difficulty",
      "note",
      "createdAt",
      "updatedAt",
    ]);
    expect([...WEEKLY_REVIEW_FIELDS]).toEqual([
      "id",
      "weekStart",
      "timezoneSnapshot",
      "summary",
      "reflection",
      "status",
      "completedAt",
      "createdAt",
    ]);
    expect([...NOTIFICATION_SETTINGS_FIELDS]).toEqual([
      "enabled",
      "localTime",
      "timezone",
      "quietHours",
    ]);
    expect([...AI_RESULT_FIELDS]).toEqual([
      "id",
      "kind",
      "status",
      "promptVersion",
      "outputSchemaVersion",
      "provider",
      "model",
      "result",
      "failureCode",
      "createdAt",
    ]);
  });

  it("どの許可リストにも、認証・運用に関わる項目名が含まれない", () => {
    const all = [
      ...ACCOUNT_FIELDS,
      ...PROFILE_FIELDS,
      ...HABIT_FIELDS,
      ...SCHEDULE_VERSION_FIELDS,
      ...HABIT_ENTRY_FIELDS,
      ...DAILY_CHECK_IN_FIELDS,
      ...WEEKLY_REVIEW_FIELDS,
      ...NOTIFICATION_SETTINGS_FIELDS,
      ...AI_RESULT_FIELDS,
    ].map((name) => name.toLowerCase());
    for (const forbidden of [
      "password",
      "passwordhash",
      "token",
      "sessiontoken",
      "secret",
      "totp",
      "recovery",
      "userid",
      "internalid",
      "inputfingerprint",
    ]) {
      expect(
        all.some((name) => name.includes(forbidden)),
        forbidden,
      ).toBe(false);
    }
  });
});

describe("pickFields", () => {
  it("許可リストの項目だけを取り出し、余計な項目は落とす。無い項目は null", () => {
    const source = { id: "a", name: "n", passwordHash: "secret", extra: 1 };
    expect(pickFields(source, ["id", "name"] as const)).toEqual({ id: "a", name: "n" });
    expect(pickFields({ id: "a" } as { id: string; name?: string }, ["id", "name"])).toEqual({
      id: "a",
      name: null,
    });
  });
});
