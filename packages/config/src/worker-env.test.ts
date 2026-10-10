import { describe, expect, it } from "vitest";
import { isNotificationDeliveryEnabled, parseWorkerEnv } from "./worker-env";

const base = {
  AWS_REGION: "ap-northeast-1",
  DATABASE_URL_SECRET_ARN: "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:db-AbCdEf",
  APP_BASE_URL: "https://app.example.test",
  EMAIL_FROM: "no-reply@habit-app.example.test",
  SES_CONFIGURATION_SET: "habit-app-config",
};

describe("parseWorkerEnv", () => {
  it("Feature Flag は既定で無効", () => {
    expect(parseWorkerEnv(base).NOTIFICATION_DELIVERY_ENABLED).toBe(false);
    expect(parseWorkerEnv({ ...base, NOTIFICATION_DELIVERY_ENABLED: "true" })).toMatchObject({
      NOTIFICATION_DELIVERY_ENABLED: true,
    });
  });

  it("true/false 以外のフラグ値は拒否する(曖昧な値で有効化しない)", () => {
    for (const bad of ["1", "yes", "TRUE", ""]) {
      expect(() => parseWorkerEnv({ ...base, NOTIFICATION_DELIVERY_ENABLED: bad })).toThrow(
        "NOTIFICATION_DELIVERY_ENABLED",
      );
    }
  });

  it("DB の接続元は URL か secret ARN のどちらかが必須", () => {
    // DB の接続元(secret ARN)を含めない環境を作る。
    const withoutDb = { ...base, DATABASE_URL_SECRET_ARN: undefined };
    expect(() => parseWorkerEnv(withoutDb)).toThrow("DATABASE_URL");
    expect(
      parseWorkerEnv({ ...withoutDb, DATABASE_URL: "postgresql://u:p@localhost:5432/db" })
        .DATABASE_URL,
    ).toBeDefined();
  });

  it("署名鍵を直接指定する場合は 32 文字以上、URL の形式違いは拒否する。役割に不要な項目は省略できる", () => {
    expect(() => parseWorkerEnv({ ...base, UNSUBSCRIBE_SIGNING_KEY: "short" })).toThrow(
      "UNSUBSCRIBE_SIGNING_KEY",
    );
    expect(() => parseWorkerEnv({ ...base, APP_BASE_URL: "not a url" })).toThrow("APP_BASE_URL");
    // feedback は DB の接続元とリージョンだけでよい。
    expect(
      parseWorkerEnv({
        AWS_REGION: base.AWS_REGION,
        DATABASE_URL_SECRET_ARN: base.DATABASE_URL_SECRET_ARN,
      }).APP_BASE_URL,
    ).toBeUndefined();
    expect(() => parseWorkerEnv({ DATABASE_URL_SECRET_ARN: base.DATABASE_URL_SECRET_ARN })).toThrow(
      "AWS_REGION",
    );
  });

  it("エラーメッセージに値を含めない", () => {
    try {
      parseWorkerEnv({ ...base, UNSUBSCRIBE_SIGNING_KEY: "short-secret" });
      throw new Error("should fail");
    } catch (error) {
      expect(String(error)).not.toContain("short-secret");
    }
  });
});

describe("isNotificationDeliveryEnabled", () => {
  it("'true' のときだけ有効(他の検証に依存しない)", () => {
    expect(isNotificationDeliveryEnabled({})).toBe(false);
    expect(isNotificationDeliveryEnabled({ NOTIFICATION_DELIVERY_ENABLED: "false" })).toBe(false);
    expect(isNotificationDeliveryEnabled({ NOTIFICATION_DELIVERY_ENABLED: "1" })).toBe(false);
    expect(isNotificationDeliveryEnabled({ NOTIFICATION_DELIVERY_ENABLED: "true" })).toBe(true);
  });
});

describe("parseWorkerEnv: AI 設定(T-303)", () => {
  it("既定は fake provider・公開無効", () => {
    expect(parseWorkerEnv(base)).toMatchObject({
      AI_PROVIDER: "fake",
      AI_PUBLICATION_ENABLED: false,
    });
  });

  it("AI_PUBLICATION_ENABLED は true / false のみ受け付ける", () => {
    expect(parseWorkerEnv({ ...base, AI_PUBLICATION_ENABLED: "true" }).AI_PUBLICATION_ENABLED).toBe(
      true,
    );
    for (const bad of ["1", "yes", "TRUE", ""]) {
      expect(() => parseWorkerEnv({ ...base, AI_PUBLICATION_ENABLED: bad })).toThrow(
        "AI_PUBLICATION_ENABLED",
      );
    }
  });

  it("未知の AI_PROVIDER は拒否する", () => {
    expect(() => parseWorkerEnv({ ...base, AI_PROVIDER: "openai" })).toThrow("AI_PROVIDER");
  });
});
