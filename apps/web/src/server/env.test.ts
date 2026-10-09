import { parseEnv } from "@habit-app/config";
import { describe, expect, it, vi } from "vitest";

import { createServerEnvGetter } from "./env";

const validSource: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  AUTH_SECRET: "x".repeat(32),
};

describe("createServerEnvGetter", () => {
  it("初回呼び出しまで parse せず、以後は結果を memoize する", () => {
    const parse = vi.fn(parseEnv);
    const getEnv = createServerEnvGetter(parse, () => validSource);

    expect(parse).not.toHaveBeenCalled();
    const first = getEnv();
    const second = getEnv();

    expect(parse).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("検証に失敗した場合は memoize せず、次回呼び出しで再検証する", () => {
    let source: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    const getEnv = createServerEnvGetter(parseEnv, () => source);

    expect(() => getEnv()).toThrow(/Invalid environment variables/);

    source = validSource;
    expect(getEnv().DATABASE_URL).toBe(validSource["DATABASE_URL"]);
  });

  it("不正な env の error に Secret の値を含めない", () => {
    const secret = "short-secret-value";
    const getEnv = createServerEnvGetter(parseEnv, () => ({
      ...validSource,
      AUTH_SECRET: secret,
    }));

    let message = "";
    try {
      getEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("AUTH_SECRET");
    expect(message).not.toContain(secret);
  });
});
