import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export const startPostgresContainer = async (): Promise<StartedPostgreSqlContainer> => {
  return new PostgreSqlContainer("postgres:16-alpine").start();
};
