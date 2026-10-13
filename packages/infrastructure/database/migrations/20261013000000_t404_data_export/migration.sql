-- T-404 PR-B データエクスポート (docs/specs/data-export.md データとMigration)
-- expand(後方互換): 新規テーブルのみ。既存のテーブルは変更しない。

-- CreateTable
CREATE TABLE "data_exports" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "failure_code" TEXT,
    "byte_size" INTEGER,
    "file_name" TEXT,
    "content_type" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "data_exports_format_check" CHECK ("format" IN ('json', 'csv')),
    CONSTRAINT "data_exports_status_check"
      CHECK ("status" IN ('queued', 'running', 'ready', 'failed', 'expired')),
    -- ready なら、ダウンロードに必要な項目がすべて設定済み(expired は表示のため値を残してよい)。
    CONSTRAINT "data_exports_ready_check" CHECK (
      "status" <> 'ready' OR (
        "expires_at" IS NOT NULL AND "byte_size" IS NOT NULL AND "completed_at" IS NOT NULL
        AND "file_name" IS NOT NULL AND "content_type" IS NOT NULL
      )
    ),
    CONSTRAINT "data_exports_failure_check" CHECK (("status" = 'failed') = ("failure_code" IS NOT NULL)),
    CONSTRAINT "data_exports_byte_size_check" CHECK ("byte_size" IS NULL OR "byte_size" >= 0)
);

-- 成果物は別テーブルに置き、一覧・状態の query が本体(bytea)を読まないようにする。
CREATE TABLE "data_export_artifacts" (
    "export_id" BIGINT NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "data_export_artifacts_pkey" PRIMARY KEY ("export_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_exports_public_id_key" ON "data_exports" ("public_id");

-- EXP-INV-004: queued/running のエクスポートは 1 ユーザーにつき 1 件(同時作成の競合を DB が拒否する)。
CREATE UNIQUE INDEX "data_exports_user_active_uidx"
  ON "data_exports" ("user_id")
  WHERE "status" IN ('queued', 'running');

-- 一覧(直近 5 件)と作成頻度の数え方: WHERE user_id = ? ORDER BY created_at DESC。FK user_id の index も兼ねる。
CREATE INDEX "data_exports_user_id_created_at_idx" ON "data_exports" ("user_id", "created_at" DESC);

-- 定期ジョブのスキャン。
CREATE INDEX "data_exports_ready_expires_at_idx" ON "data_exports" ("expires_at") WHERE "status" = 'ready';
CREATE INDEX "data_exports_closed_updated_at_idx"
  ON "data_exports" ("updated_at") WHERE "status" IN ('failed', 'expired');

-- AddForeignKey
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "data_export_artifacts" ADD CONSTRAINT "data_export_artifacts_export_id_fkey"
  FOREIGN KEY ("export_id") REFERENCES "data_exports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- updated_at は生 SQL でも一貫させる(既存の set_updated_at を使う)。
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "data_exports"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
