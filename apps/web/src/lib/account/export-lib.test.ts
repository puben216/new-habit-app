import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/lib/api/api-error";

import { dataExportDownloadPath } from "./export-api";
import {
  EXPORT_IN_PROGRESS_MESSAGE,
  EXPORT_NETWORK_MESSAGE,
  EXPORT_RATE_LIMITED_MESSAGE,
  EXPORT_REAUTH_FAILED_MESSAGE,
  EXPORT_TOO_MANY_ATTEMPTS_MESSAGE,
  EXPORT_UNAVAILABLE_MESSAGE,
  EXPORT_UNEXPECTED_MESSAGE,
  classifyExportError,
  exportErrorMessage,
  exportFailureMessage,
  exportFormatLabel,
  exportStatusLabel,
  formatByteSize,
  isExportActive,
} from "./export-messages";

const error = (status: number, code: string) => new ApiError({ status, code });

describe("classifyExportError / exportErrorMessage", () => {
  it.each([
    [error(403, "reauthentication_failed"), "reauth_failed", EXPORT_REAUTH_FAILED_MESSAGE],
    [error(429, "too_many_attempts"), "too_many_attempts", EXPORT_TOO_MANY_ATTEMPTS_MESSAGE],
    [error(429, "export_rate_limited"), "rate_limited", EXPORT_RATE_LIMITED_MESSAGE],
    [error(409, "export_in_progress"), "in_progress", EXPORT_IN_PROGRESS_MESSAGE],
    [error(503, "export_unavailable"), "unavailable", EXPORT_UNAVAILABLE_MESSAGE],
    [error(0, CLIENT_ERROR_CODES.networkError), "network", EXPORT_NETWORK_MESSAGE],
    [error(500, "internal"), "unexpected", EXPORT_UNEXPECTED_MESSAGE],
    [error(422, "validation_failed"), "unexpected", EXPORT_UNEXPECTED_MESSAGE],
    [new Error("boom"), "unexpected", EXPORT_UNEXPECTED_MESSAGE],
  ] as const)("%# を分類して固定文言にする", (input, kind, message) => {
    expect(classifyExportError(input)).toBe(kind);
    expect(exportErrorMessage(kind)).toBe(message);
  });

  it("status と code の組が合わなければ別の種類として扱わない", () => {
    expect(classifyExportError(error(429, "reauthentication_failed"))).toBe("unexpected");
    expect(classifyExportError(error(409, "export_rate_limited"))).toBe("unexpected");
    expect(classifyExportError(error(403, "export_in_progress"))).toBe("unexpected");
  });
});

describe("状態・形式・失敗のラベル", () => {
  it("既知の状態は日本語、未知はそのまま。実行中の判定は queued/running だけ", () => {
    expect(exportStatusLabel("queued")).toBe("待機中");
    expect(exportStatusLabel("running")).toBe("作成中");
    expect(exportStatusLabel("ready")).toBe("ダウンロードできます");
    expect(exportStatusLabel("failed")).toBe("作成に失敗しました");
    expect(exportStatusLabel("expired")).toBe("期限が切れました");
    expect(exportStatusLabel("other")).toBe("other");
    for (const status of ["queued", "running"]) expect(isExportActive(status)).toBe(true);
    for (const status of ["ready", "failed", "expired", "x"]) {
      expect(isExportActive(status)).toBe(false);
    }
  });

  it("形式のラベルと、失敗の説明(データの内容を含めない)", () => {
    expect(exportFormatLabel("json")).toBe("JSON");
    expect(exportFormatLabel("csv")).toBe("CSV(ZIP)");
    expect(exportFailureMessage("too_large")).toContain("大きすぎ");
    for (const code of ["worker_error", "generation_failed", "enqueue_failed", null, "unknown"]) {
      expect(exportFailureMessage(code)).toBe("作成できませんでした。もう一度お試しください。");
    }
  });
});

describe("formatByteSize", () => {
  it("単位を切り替える(1024 区切り)", () => {
    expect(formatByteSize(0)).toBe("0 バイト");
    expect(formatByteSize(1023)).toBe("1023 バイト");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("性質: 常に数字と単位を含む文字列で、負にならない", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 * 1024 * 1024 }), (bytes) => {
        expect(formatByteSize(bytes)).toMatch(/^\d+(\.\d)? (バイト|KB|MB)$/);
      }),
    );
  });
});

describe("dataExportDownloadPath", () => {
  it("UUID だけをリンク先にし、それ以外(パス操作を含む)は null", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(dataExportDownloadPath(id)).toBe(`/api/v1/me/exports/${id}/download`);
    for (const bad of ["", "1", "../x", `${id}/../x`, `${id}?x=1`, "javascript:alert(1)"]) {
      expect(dataExportDownloadPath(bad), bad).toBeNull();
    }
  });
});
