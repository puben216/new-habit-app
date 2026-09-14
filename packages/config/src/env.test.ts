import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  it("有効な環境変数をパースできる", () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    });

    expect(env).toEqual({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    });
  });

  it("NODE_ENVを省略した場合はdevelopmentが既定値になる", () => {
    const env = parseEnv({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    });

    expect(env.NODE_ENV).toBe("development");
  });

  it("DATABASE_URLが欠落している場合はエラーを投げる", () => {
    expect(() => parseEnv({ NODE_ENV: "test" })).toThrow(/DATABASE_URL/);
  });

  it("DATABASE_URLが不正なURLの場合はエラーを投げる", () => {
    expect(() => parseEnv({ NODE_ENV: "test", DATABASE_URL: "not-a-url" })).toThrow(/DATABASE_URL/);
  });

  it("NODE_ENVが未知の値の場合はエラーを投げる", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "staging",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      }),
    ).toThrow(/NODE_ENV/);
  });
});
