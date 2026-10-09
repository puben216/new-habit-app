import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

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

  it("UNSUBSCRIBE_SIGNING_KEYは省略でき、指定する場合は32文字以上が必要", () => {
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      AUTH_SECRET,
    };
    expect(parseEnv(base).UNSUBSCRIBE_SIGNING_KEY).toBeUndefined();
    expect(
      parseEnv({ ...base, UNSUBSCRIBE_SIGNING_KEY: "k".repeat(32) }).UNSUBSCRIBE_SIGNING_KEY,
    ).toBe("k".repeat(32));
    expect(() => parseEnv({ ...base, UNSUBSCRIBE_SIGNING_KEY: "k".repeat(31) })).toThrow(
      "UNSUBSCRIBE_SIGNING_KEY",
    );
  });
});
