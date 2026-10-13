import { describe, expect, it } from "vitest";

import {
  createDataExportRequestSchema,
  dataExportListResponseSchema,
  dataExportMessageV1Schema,
  dataExportResponseSchema,
} from "./data-export";

const ID = "11111111-2222-4333-8444-555555555555";
const parse = (body: unknown) => createDataExportRequestSchema.safeParse(body);

describe("createDataExportRequestSchema", () => {
  it("password と format(json/csv)だけを受け付ける。パスワードの空白は変更しない", () => {
    expect(parse({ password: "pw", format: "json" })).toMatchObject({ success: true });
    expect(parse({ password: " pw ", format: "csv" })).toMatchObject({
      success: true,
      data: { password: " pw ", format: "csv" },
    });
  });

  it("format の不正値・欠落、password の空・上限超過・型違いを拒否する。上限ちょうどは受理する", () => {
    expect(parse({ password: "pw", format: "xml" }).success).toBe(false);
    expect(parse({ password: "pw", format: "JSON" }).success).toBe(false);
    expect(parse({ password: "pw" }).success).toBe(false);
    expect(parse({ format: "json" }).success).toBe(false);
    expect(parse({ password: "", format: "json" }).success).toBe(false);
    expect(parse({ password: 1, format: "json" }).success).toBe(false);
    expect(parse({ password: "a".repeat(128), format: "json" }).success).toBe(true);
    expect(parse({ password: "a".repeat(129), format: "json" }).success).toBe(false);
  });

  it.each(["userId", "email", "exportId", "scope"])("未知キー %s を拒否する", (key) => {
    expect(parse({ password: "pw", format: "json", [key]: "x" }).success).toBe(false);
  });
});

describe("response / message schemas", () => {
  const item = {
    id: ID,
    status: "ready",
    format: "json",
    requestedAt: "2026-10-13T03:00:00.000Z",
    expiresAt: "2026-10-14T03:00:12.000Z",
    byteSize: 12480,
    failureCode: null,
  };

  it("エクスポート 1 件と一覧を表現できる", () => {
    expect(dataExportResponseSchema.safeParse(item).success).toBe(true);
    expect(
      dataExportResponseSchema.safeParse({
        ...item,
        status: "queued",
        expiresAt: null,
        byteSize: null,
      }).success,
    ).toBe(true);
    expect(dataExportListResponseSchema.safeParse({ items: [item, item] }).success).toBe(true);
  });

  it("不正な status・format・ID、負のサイズを拒否する", () => {
    for (const bad of [
      { ...item, status: "done" },
      { ...item, format: "xml" },
      { ...item, id: "not-a-uuid" },
      { ...item, byteSize: -1 },
    ]) {
      expect(dataExportResponseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("queue message は version と公開 ID だけで、余計な項目を持てない", () => {
    expect(dataExportMessageV1Schema.safeParse({ version: 1, exportId: ID }).success).toBe(true);
    expect(dataExportMessageV1Schema.safeParse({ version: 2, exportId: ID }).success).toBe(false);
    expect(dataExportMessageV1Schema.safeParse({ version: 1, exportId: "1" }).success).toBe(false);
    expect(
      dataExportMessageV1Schema.safeParse({ version: 1, exportId: ID, userId: "42" }).success,
    ).toBe(false);
  });
});
