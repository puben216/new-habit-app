import { randomUUID } from "node:crypto";
import {
  disableAdminUseCase,
  grantAdminUseCase,
  resetAdminMfaUseCase,
} from "@habit-app/application";
import type { ProvisionAdminDeps } from "@habit-app/application";

import { createPrismaClient } from "../database/prisma-client";
import { createAdminCrypto } from "./admin-crypto";
import { runAdminCli } from "./admin-cli";
import {
  createPrismaAdminProvisioningRepository,
  createPrismaAuditLogRepository,
} from "./prisma-admin-repositories";

/**
 * 運用スクリプトの実行入口(`pnpm admin:grant|admin:disable|admin:reset-mfa`)。
 * DB と暗号鍵に到達できる環境でだけ実行できる(Web/API からは実行できない)。
 * 必要な環境変数: DATABASE_URL、ADMIN_TOTP_ENCRYPTION_KEY。値はログ・出力に含めない。
 */
async function main(): Promise<number> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // .env がなくても、環境変数が直接設定されていればよい。
  }
  const databaseUrl = process.env["DATABASE_URL"];
  const encryptionKey = process.env["ADMIN_TOTP_ENCRYPTION_KEY"];
  if (databaseUrl === undefined || encryptionKey === undefined) {
    console.error("DATABASE_URL と ADMIN_TOTP_ENCRYPTION_KEY を設定してください。");
    return 2;
  }

  const prisma = createPrismaClient(databaseUrl);
  try {
    const deps: ProvisionAdminDeps = {
      provisioning: createPrismaAdminProvisioningRepository(prisma),
      crypto: createAdminCrypto(encryptionKey),
      audit: createPrismaAuditLogRepository(prisma),
      now: () => new Date(),
      requestId: randomUUID(),
    };
    const result = await runAdminCli(process.argv.slice(2), {
      grant: (email) => grantAdminUseCase(deps, { email }),
      disable: (email) => disableAdminUseCase(deps, { email }),
      resetMfa: (email) => resetAdminMfaUseCase(deps, { email }),
    });
    for (const line of result.stdout) console.log(line);
    for (const line of result.stderr) console.error(line);
    return result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // 例外の詳細(接続文字列・SQL など)を出力しない。
    console.error("実行に失敗しました。DB への接続と設定を確認してください。");
    process.exitCode = 1;
  },
);
