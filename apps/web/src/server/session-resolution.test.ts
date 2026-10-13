import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 構造の検査(docs/specs/account-deletion.md ACD-INV-003): 削除予約中の session は、Member 向けの全 API で
 * actor を持たない。その遮断は `actorUserIdFromSession` に集約されているため、各 composition root が
 * `auth()` の結果から `user.id` を直接読む(= 遮断を迂回する)実装になっていないことを確かめる。
 * 新しい API の container が同じ迂回をしたときに、ここで失敗する。
 */
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const containers = fs.readdirSync(serverDir).filter((name) => name.endsWith("-container.ts"));

/** コメントを除いたコードだけを検査する(説明文中の `session.user.id` に反応しない)。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const RESOLVERS = ["actorUserIdFromSession(", "accountSessionFromAuth(", "adminSessionFromAuth("];

describe("session の解決(削除予約中の遮断を迂回しない)", () => {
  it("container を検査対象として見つけている(検査が空振りしない)", () => {
    expect(containers.length).toBeGreaterThanOrEqual(10);
    expect(containers).toContain("habit-container.ts");
  });

  it.each(containers)("%s は auth() の結果を、集約した関数を通してのみ使う", (name) => {
    const source = stripComments(fs.readFileSync(path.join(serverDir, name), "utf8"));
    if (!source.includes("auth()")) return; // session を使わない container。

    expect(
      RESOLVERS.some((resolver) => source.includes(resolver)),
      `${name}: resolver`,
    ).toBe(true);
    // `session.user.id` / `session?.user?.id` / `user?.id` の直接参照は遮断を迂回する。
    expect(source, `${name}: 直接参照`).not.toMatch(/\.user\??\.id\b|\buser\??\.id\b/);
  });
});
