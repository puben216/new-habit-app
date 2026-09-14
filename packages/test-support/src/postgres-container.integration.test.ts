import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer } from "./postgres-container";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("startPostgresContainer", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await startPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it("起動したコンテナに接続してヘルスチェックできる", async () => {
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    try {
      const result = await client.query<{ ok: number }>("SELECT 1 AS ok");
      expect(result.rows[0]).toEqual({ ok: 1 });
    } finally {
      await client.end();
    }
  });
});
