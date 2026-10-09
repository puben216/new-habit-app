import { describe, expect, it } from "vitest";
import { parseEnv, parseWorkerEnv } from "./env";

const AUTH_SECRET = "a".repeat(32);

describe("parseEnv", () => {
  it("有効な環境変数をパースできる", () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      AUTH_SECRET,
    });

    expect(env).toEqual({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      AUTH_SECRET,
      AUTH_EMAIL_SENDER: "smtp",
      SMTP_HOST: "localhost",
      SMTP_PORT: 1025,
      EMAIL_FROM: "no-reply@habit-app.local",
      APP_BASE_URL: "http://localhost:3000",
      AI_QUEUE_DRIVER: "inline",
      AI_PROVIDER: "fake",
      AI_PUBLICATION_ENABLED: false,
    });
  });

  it("NODE_ENVを省略した場合はdevelopmentが既定値になる", () => {
    const env = parseEnv({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      AUTH_SECRET,
    });

    expect(env.NODE_ENV).toBe("development");
  });

  it("DATABASE_URLが欠落している場合はエラーを投げる", () => {
    expect(() => parseEnv({ NODE_ENV: "test", AUTH_SECRET })).toThrow(/DATABASE_URL/);
  });

  it("DATABASE_URLが不正なURLの場合はエラーを投げる", () => {
    expect(() => parseEnv({ NODE_ENV: "test", DATABASE_URL: "not-a-url", AUTH_SECRET })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("NODE_ENVが未知の値の場合はエラーを投げる", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "staging",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        AUTH_SECRET,
      }),
    ).toThrow(/NODE_ENV/);
  });

  it("AUTH_SECRETが欠落している場合はエラーを投げる", () => {
    expect(() =>
      parseEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://user:pass@localhost:5432/db" }),
    ).toThrow(/AUTH_SECRET/);
  });

  it("AUTH_SECRETが32文字未満の場合はエラーを投げる", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        AUTH_SECRET: "short",
      }),
    ).toThrow(/AUTH_SECRET/);
  });

  it("本番環境でAUTH_EMAIL_SENDER=smtpの場合はエラーを投げる", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        AUTH_SECRET,
        AUTH_EMAIL_SENDER: "smtp",
      }),
    ).toThrow(/AUTH_EMAIL_SENDER/);
  });

  it("本番環境でAUTH_EMAIL_SENDER=sesの場合は許可される", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      AUTH_SECRET,
      AUTH_EMAIL_SENDER: "ses",
      AI_QUEUE_DRIVER: "sqs",
    });

    expect(env.AUTH_EMAIL_SENDER).toBe("ses");
  });

  it("SMTP_PORTは数値文字列からcoerceされる", () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      AUTH_SECRET,
      SMTP_PORT: "2525",
    });

    expect(env.SMTP_PORT).toBe(2525);
  });

  describe("AI 設定(T-303)", () => {
    const base = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      AUTH_SECRET,
    };

    it("既定値は inline / fake / 公開無効", () => {
      const env = parseEnv({ ...base, NODE_ENV: "test" });
      expect(env.AI_QUEUE_DRIVER).toBe("inline");
      expect(env.AI_PROVIDER).toBe("fake");
      expect(env.AI_PUBLICATION_ENABLED).toBe(false);
    });

    it("AI_PUBLICATION_ENABLED は true / false の文字列のみ受け付ける", () => {
      expect(
        parseEnv({ ...base, NODE_ENV: "test", AI_PUBLICATION_ENABLED: "true" })
          .AI_PUBLICATION_ENABLED,
      ).toBe(true);
      expect(
        parseEnv({ ...base, NODE_ENV: "test", AI_PUBLICATION_ENABLED: "false" })
          .AI_PUBLICATION_ENABLED,
      ).toBe(false);
      for (const value of ["1", "yes", "TRUE", ""]) {
        expect(() =>
          parseEnv({ ...base, NODE_ENV: "test", AI_PUBLICATION_ENABLED: value }),
        ).toThrow(/AI_PUBLICATION_ENABLED/);
      }
    });

    it("未知の AI_QUEUE_DRIVER / AI_PROVIDER は拒否する", () => {
      expect(() => parseEnv({ ...base, NODE_ENV: "test", AI_QUEUE_DRIVER: "kafka" })).toThrow(
        /AI_QUEUE_DRIVER/,
      );
      expect(() => parseEnv({ ...base, NODE_ENV: "test", AI_PROVIDER: "openai" })).toThrow(
        /AI_PROVIDER/,
      );
    });

    it("本番環境で AI_QUEUE_DRIVER=inline(既定を含む)は拒否する", () => {
      expect(() => parseEnv({ ...base, NODE_ENV: "production", AUTH_EMAIL_SENDER: "ses" })).toThrow(
        /AI_QUEUE_DRIVER/,
      );
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: "production",
          AUTH_EMAIL_SENDER: "ses",
          AI_QUEUE_DRIVER: "inline",
        }),
      ).toThrow(/AI_QUEUE_DRIVER/);
    });

    it("本番環境で sqs かつ公開無効なら許可される(fake のままでも provider は呼ばれない)", () => {
      const env = parseEnv({
        ...base,
        NODE_ENV: "production",
        AUTH_EMAIL_SENDER: "ses",
        AI_QUEUE_DRIVER: "sqs",
      });
      expect(env.AI_QUEUE_DRIVER).toBe("sqs");
    });

    it("本番環境で fake provider のまま公開を有効にすることは拒否する", () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: "production",
          AUTH_EMAIL_SENDER: "ses",
          AI_QUEUE_DRIVER: "sqs",
          AI_PUBLICATION_ENABLED: "true",
        }),
      ).toThrow(/AI_PROVIDER/);
    });

    it("開発・テスト環境では fake provider で公開を有効にできる", () => {
      const env = parseEnv({ ...base, NODE_ENV: "development", AI_PUBLICATION_ENABLED: "true" });
      expect(env.AI_PUBLICATION_ENABLED).toBe(true);
    });
  });
});

describe("parseWorkerEnv(T-303)", () => {
  const base = { DATABASE_URL: "postgresql://user:pass@localhost:5432/db" };

  it("DATABASE_URL だけで起動でき、認証・メールの Secret を要求しない(既定は公開無効)", () => {
    expect(parseWorkerEnv({ ...base, NODE_ENV: "test" })).toEqual({
      NODE_ENV: "test",
      DATABASE_URL: base.DATABASE_URL,
      AI_PROVIDER: "fake",
      AI_PUBLICATION_ENABLED: false,
    });
  });

  it("DATABASE_URL の欠落・不正は拒否する", () => {
    expect(() => parseWorkerEnv({ NODE_ENV: "test" })).toThrow(/DATABASE_URL/);
    expect(() => parseWorkerEnv({ NODE_ENV: "test", DATABASE_URL: "x" })).toThrow(/DATABASE_URL/);
  });

  it("AI_PUBLICATION_ENABLED は true / false のみ", () => {
    expect(
      parseWorkerEnv({ ...base, NODE_ENV: "test", AI_PUBLICATION_ENABLED: "true" })
        .AI_PUBLICATION_ENABLED,
    ).toBe(true);
    expect(() => parseWorkerEnv({ ...base, AI_PUBLICATION_ENABLED: "1" })).toThrow(
      /AI_PUBLICATION_ENABLED/,
    );
  });

  it("本番で fake provider のまま公開を有効にすることは拒否し、公開無効なら許可する", () => {
    expect(() =>
      parseWorkerEnv({ ...base, NODE_ENV: "production", AI_PUBLICATION_ENABLED: "true" }),
    ).toThrow(/AI_PROVIDER/);
    expect(parseWorkerEnv({ ...base, NODE_ENV: "production" }).AI_PUBLICATION_ENABLED).toBe(false);
  });
});
