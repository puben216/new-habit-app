import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// pnpm --filter経由で実行するとcwdはこのpackage直下になるため、
// リポジトリルートの.env(T-003で導入)を明示的に読み込む。
config({ path: "../../.env" });

export default defineConfig({
  schema: "database/schema.prisma",
  migrations: {
    path: "database/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
