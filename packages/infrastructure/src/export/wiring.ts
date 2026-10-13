import type { ProcessDataExportDeps } from "@habit-app/application";
import type { PrismaClient } from "../generated/prisma/client";
import { createPrismaDataExportRepository } from "./prisma-data-export-repository";
import { createPrismaExportDataSource } from "./prisma-export-data-source";

/** web(inline queue)と workers(SQS handler)が共有する、エクスポート処理の依存の配線。 */
export function createDataExportProcessDeps(prisma: PrismaClient): ProcessDataExportDeps {
  return {
    exports: createPrismaDataExportRepository(prisma),
    dataSource: createPrismaExportDataSource(prisma),
    now: () => new Date(),
  };
}
