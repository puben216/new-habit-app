import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DATA_EXPORT_DAILY_LIMIT,
  DATA_EXPORT_MAX_BYTES,
  DATA_EXPORT_TTL_HOURS,
  exportExpiresAt,
  exportFileInfo,
  exportRateWindowStart,
  exportRetentionCutoff,
  exportStaleCutoff,
  DATA_EXPORT_STALE_MINUTES,
  isDataExportFormat,
  isDataExportStatus,
  isExportExpired,
} from "./constants";

const HOUR_MS = 60 * 60 * 1000;
const COMPLETED = new Date("2026-10-13T03:00:12.000Z");

describe("定数(Spec の暫定値)", () => {
  it("期限 24 時間、頻度 5 件/日、上限 20 MiB", () => {
    expect(DATA_EXPORT_TTL_HOURS).toBe(24);
    expect(DATA_EXPORT_DAILY_LIMIT).toBe(5);
    expect(DATA_EXPORT_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("exportExpiresAt / isExportExpired", () => {
  it("期限は完成の 24 時間後。ちょうどの時刻から期限切れ(境界を含む)", () => {
    const expiresAt = exportExpiresAt(COMPLETED);
    expect(expiresAt.toISOString()).toBe("2026-10-14T03:00:12.000Z");
    expect(isExportExpired(expiresAt, new Date(expiresAt.getTime() - 1))).toBe(false);
    expect(isExportExpired(expiresAt, expiresAt)).toBe(true);
    expect(isExportExpired(expiresAt, new Date(expiresAt.getTime() + 1))).toBe(true);
  });

  it("性質: 完成からの経過時間が 24 時間以上のときだけ期限切れで、時間とともに単調に切れる", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2020-01-01"), max: new Date("2100-01-01"), noInvalidDate: true }),
        fc.integer({ min: 0, max: 100 * HOUR_MS }),
        fc.integer({ min: 0, max: 100 * HOUR_MS }),
        (completed, a, b) => {
          const expiresAt = exportExpiresAt(completed);
          const [early, late] = a <= b ? [a, b] : [b, a];
          const at = (offset: number) => new Date(completed.getTime() + offset);
          expect(isExportExpired(expiresAt, at(early))).toBe(early >= 24 * HOUR_MS);
          if (isExportExpired(expiresAt, at(early))) {
            expect(isExportExpired(expiresAt, at(late))).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("頻度・保持の基準時刻", () => {
  it("頻度の数え始めは 24 時間前、失敗/期限切れの行の削除基準は 7 日前", () => {
    const now = new Date("2026-10-13T00:00:00.000Z");
    expect(exportRateWindowStart(now).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(exportRetentionCutoff(now).toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("停止したジョブの判定", () => {
  it("60 分更新が無い queued/running を停止とみなす(基準時刻は 60 分前)", () => {
    expect(DATA_EXPORT_STALE_MINUTES).toBe(60);
    const now = new Date("2026-10-13T03:00:00.000Z");
    expect(exportStaleCutoff(now).toISOString()).toBe("2026-10-13T02:00:00.000Z");
  });

  it("性質: 基準時刻は常に now より過去で、ちょうど 60 分差", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2020-01-01"), max: new Date("2100-01-01"), noInvalidDate: true }),
        (now) => {
          expect(now.getTime() - exportStaleCutoff(now).getTime()).toBe(60 * 60 * 1000);
        },
      ),
    );
  });
});

describe("exportFileInfo", () => {
  it("形式ごとの Content-Type と、完成日(UTC)だけから作る固定のファイル名", () => {
    expect(exportFileInfo("json", COMPLETED)).toEqual({
      contentType: "application/json; charset=utf-8",
      fileName: "habit-app-export-20261013.json",
    });
    expect(exportFileInfo("csv", COMPLETED)).toEqual({
      contentType: "application/zip",
      fileName: "habit-app-export-20261013.zip",
    });
  });

  it("性質: ファイル名は常に安全な ASCII で、拡張子は形式に一致する", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01"), max: new Date("2100-01-01"), noInvalidDate: true }),
        fc.constantFrom("json" as const, "csv" as const),
        (date, format) => {
          const { fileName } = exportFileInfo(format, date);
          expect(fileName).toMatch(/^habit-app-export-\d{8}\.(json|zip)$/);
          expect(fileName.endsWith(format === "json" ? ".json" : ".zip")).toBe(true);
        },
      ),
    );
  });
});

describe("型ガード", () => {
  it("形式と状態の値域だけを通す", () => {
    expect(isDataExportFormat("json")).toBe(true);
    expect(isDataExportFormat("csv")).toBe(true);
    for (const bad of ["xml", "JSON", "", null, undefined, 1]) {
      expect(isDataExportFormat(bad)).toBe(false);
    }
    for (const ok of ["queued", "running", "ready", "failed", "expired"]) {
      expect(isDataExportStatus(ok)).toBe(true);
    }
    for (const bad of ["done", "READY", "", null, 0]) expect(isDataExportStatus(bad)).toBe(false);
  });
});
