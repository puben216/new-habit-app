import fc from "fast-check";
import {
  DATA_EXPORT_DAILY_LIMIT,
  DATA_EXPORT_MAX_BYTES,
  DATA_EXPORT_MAX_RECEIVE,
  DATA_EXPORT_TTL_HOURS,
  buildExportJson,
} from "@habit-app/domain";
import type { ExportBundle } from "@habit-app/domain";
import { describe, expect, it } from "vitest";

import {
  AccountNotActiveError,
  AccountNotFoundError,
  ReauthenticationFailedError,
  TooManyAttemptsError,
} from "../account";
import {
  createFakeAccountRepository,
  createFakeLoginAttempts,
  type FakeAccount,
} from "../account/test-fakes";
import { createFakePasswordHasher } from "../auth/test-fakes";
import {
  ExportExpiredError,
  ExportInProgressError,
  ExportNotFoundError,
  ExportNotReadyError,
  ExportRateLimitedError,
  ExportUnavailableError,
} from "./errors";
import { handleDataExportMessages } from "./handler";
import {
  createFakeDataExportRepository,
  createFakeDataSource,
  createFakeQueue,
  sampleBundle,
} from "./test-fakes";
import {
  cleanupExpiredDataExportsUseCase,
  downloadDataExportUseCase,
  effectiveExportStatus,
  listDataExportsUseCase,
  processDataExportUseCase,
  requestDataExportUseCase,
} from "./use-cases";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-10-13T03:00:00.000Z");
const CONTEXT = { requestId: "req-1", ipHash: "hash" };
const PASSWORD = "correct horse battery staple";
const USER_A = "1";
const USER_B = "2";

const hasher = createFakePasswordHasher();
const decoder = new TextDecoder();

async function account(userId: string, overrides: Partial<FakeAccount> = {}): Promise<FakeAccount> {
  return {
    userId,
    publicId: `00000000-0000-4000-8000-${userId.padStart(12, "0")}`,
    emailNormalized: `user${userId}@example.test`,
    passwordHash: await hasher.hash(PASSWORD),
    status: "active",
    deletedAt: null,
    sessionCount: 1,
    ...overrides,
  };
}

async function setup(options: { accounts?: FakeAccount[]; bundle?: ExportBundle } = {}) {
  const accounts = createFakeAccountRepository(
    options.accounts ?? [await account(USER_A), await account(USER_B)],
  );
  const exports = createFakeDataExportRepository([USER_A, USER_B], NOW);
  const queue = createFakeQueue();
  const attempts = createFakeLoginAttempts();
  const dataSource = createFakeDataSource(options.bundle ?? sampleBundle());
  let current = NOW;
  const now = () => current;
  const setNow = (value: Date) => {
    current = value;
    exports.clock = value;
  };

  const requestDeps = { accounts, exports, queue, passwordHasher: hasher, attempts, now };
  const processDeps = { exports, dataSource, now };
  return {
    accounts,
    exports,
    queue,
    attempts,
    dataSource,
    setNow,
    now,
    request: (format: "json" | "csv" = "json", password = PASSWORD, actorUserId = USER_A) =>
      requestDataExportUseCase(requestDeps, { actorUserId, password, format, context: CONTEXT }),
    process: (exportId: string, receiveCount = 1) =>
      processDataExportUseCase(processDeps, { exportId, receiveCount }),
    list: (actorUserId = USER_A) => listDataExportsUseCase({ exports, now }, { actorUserId }),
    download: (exportId: string, actorUserId = USER_A) =>
      downloadDataExportUseCase({ exports, now }, { actorUserId, exportId, context: CONTEXT }),
    cleanup: () => cleanupExpiredDataExportsUseCase({ exports, now }),
    processDeps,
  };
}

describe("requestDataExportUseCase(EXP-001)", () => {
  it("再認証に成功すると queued で作成し、queue に公開 ID だけの message を投入し、監査を残す", async () => {
    const { request, exports, queue, attempts } = await setup();
    const created = await request("csv");
    expect(created).toMatchObject({ status: "queued", format: "csv", userId: USER_A });
    expect(queue.messages).toEqual([{ version: 1, exportId: created.id }]);
    expect(exports.audit).toEqual([
      { action: "user.export.requested", userId: USER_A, exportId: created.id, requestId: "req-1" },
    ]);
    expect(attempts.records).toEqual([
      { purpose: "reauth", email: "user1@example.test", succeeded: true },
    ]);
  });

  it("パスワードが誤りなら作成せず投入もしない。失敗を reauth として記録し、パスワードをどこにも残さない", async () => {
    const { request, exports, queue, attempts } = await setup();
    const error = await request("json", "secret-wrong").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReauthenticationFailedError);
    expect(exports.rows.size).toBe(0);
    expect(queue.messages).toEqual([]);
    expect(attempts.records).toEqual([
      { purpose: "reauth", email: "user1@example.test", succeeded: false },
    ]);
    expect(JSON.stringify([String(error), attempts.records, exports.audit])).not.toContain(
      "secret-wrong",
    );
  });

  it("失敗が 5 回続くと、正しいパスワードでも検証せず拒否する", async () => {
    const { request, exports } = await setup();
    for (let i = 0; i < 5; i += 1) {
      await expect(request("json", "wrong")).rejects.toThrow(ReauthenticationFailedError);
    }
    await expect(request("json")).rejects.toThrow(TooManyAttemptsError);
    expect(exports.rows.size).toBe(0);
  });

  it("user がいない・active ではない場合は、パスワードを検証する前に拒否する", async () => {
    const pending = await account("3", { status: "deletion_pending", deletedAt: NOW });
    const { request, attempts } = await setup({
      accounts: [await account(USER_A), pending],
    });
    await expect(request("json", PASSWORD, "999")).rejects.toThrow(AccountNotFoundError);
    await expect(request("json", PASSWORD, "3")).rejects.toThrow(AccountNotActiveError);
    expect(attempts.records).toEqual([]);
  });

  it("実行中(queued/running)のエクスポートがあれば作成しない", async () => {
    const { request, exports } = await setup();
    await request();
    await expect(request()).rejects.toThrow(ExportInProgressError);
    expect(exports.rows.size).toBe(1);
  });

  it("直近 24 時間に上限まで作成すると、さらに作成できない。24 時間後は作成できる", async () => {
    const { request, exports, process, setNow } = await setup();
    for (let i = 0; i < DATA_EXPORT_DAILY_LIMIT; i += 1) {
      const created = await request();
      await process(created.id);
      setNow(new Date(NOW.getTime() + (i + 1) * 60_000));
    }
    expect(exports.rows.size).toBe(DATA_EXPORT_DAILY_LIMIT);
    await expect(request()).rejects.toThrow(ExportRateLimitedError);

    setNow(new Date(NOW.getTime() + 25 * HOUR_MS));
    await expect(request()).resolves.toMatchObject({ status: "queued" });
  });

  it("新しく作成すると、完成済みの古いエクスポートは無効になり成果物が消える", async () => {
    const { request, exports, process } = await setup();
    const first = await request();
    await process(first.id);
    expect(exports.rows.get(first.id)?.status).toBe("ready");
    await request("csv");
    expect(exports.rows.get(first.id)).toMatchObject({ status: "expired", content: null });
  });

  it("queue への投入に失敗したら failed(enqueue_failed)にして ExportUnavailableError", async () => {
    const { request, exports, queue } = await setup();
    queue.failNext = true;
    await expect(request()).rejects.toThrow(ExportUnavailableError);
    const [row] = [...exports.rows.values()];
    expect(row).toMatchObject({ status: "failed", failureCode: "enqueue_failed" });
    // 失敗した行は実行中ではないため、すぐに作り直せる。
    await expect(request()).resolves.toMatchObject({ status: "queued" });
  });
});

describe("停止した job(EXP-001/007)", () => {
  it("60 分以上更新のない queued は停止とみなされ、新しいエクスポートを作成できる(永久に作れなくならない)", async () => {
    const { request, exports, setNow, queue } = await setup();
    const stuck = await request(); // 投入前にプロセスが落ちた等で、queued のまま残った行
    await expect(request()).rejects.toThrow(ExportInProgressError);

    setNow(new Date(NOW.getTime() + 61 * 60_000));
    const fresh = await request();
    expect(fresh.status).toBe("queued");
    expect(exports.rows.get(stuck.id)).toMatchObject({
      status: "failed",
      failureCode: "worker_error",
    });
    expect(queue.messages).toHaveLength(2);
  });

  it("境界: ちょうど 60 分でも停止とみなし、59 分では実行中のまま", async () => {
    const { request, setNow } = await setup();
    await request();
    setNow(new Date(NOW.getTime() + 59 * 60_000));
    await expect(request()).rejects.toThrow(ExportInProgressError);
    setNow(new Date(NOW.getTime() + 60 * 60_000));
    await expect(request()).resolves.toMatchObject({ status: "queued" });
  });

  it("定期ジョブも停止した job を failed(worker_error)にする。処理中の新しい job は触らない。冪等", async () => {
    const { request, cleanup, exports, setNow } = await setup();
    const stale = await request();
    setNow(new Date(NOW.getTime() + 30 * 60_000));
    await expect(cleanup()).resolves.toEqual({ expired: 0, staleFailed: 0, deleted: 0 });
    expect(exports.rows.get(stale.id)?.status).toBe("queued");

    setNow(new Date(NOW.getTime() + 61 * 60_000));
    await expect(cleanup()).resolves.toEqual({ expired: 0, staleFailed: 1, deleted: 0 });
    expect(exports.rows.get(stale.id)).toMatchObject({
      status: "failed",
      failureCode: "worker_error",
    });
    await expect(cleanup()).resolves.toEqual({ expired: 0, staleFailed: 0, deleted: 0 });
  });
});

describe("processDataExportUseCase(EXP-002)", () => {
  it("JSON: 収集して生成し、ready に確定する。期限は完成の 24 時間後、ファイル名は固定", async () => {
    const { request, process, exports, dataSource } = await setup();
    const created = await request("json");
    await expect(process(created.id)).resolves.toBe("done");

    expect(dataSource.collected).toEqual([USER_A]);
    const row = exports.rows.get(created.id);
    expect(row).toMatchObject({
      status: "ready",
      fileName: "habit-app-export-20261013.json",
      contentType: "application/json; charset=utf-8",
      completedAt: NOW,
      expiresAt: new Date(NOW.getTime() + DATA_EXPORT_TTL_HOURS * HOUR_MS),
    });
    const json = JSON.parse(decoder.decode(row?.content ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
    expect(json["schemaVersion"]).toBe(1);
    expect(row?.byteSize).toBe(row?.content?.length);
  });

  it("CSV: 無圧縮の ZIP(PK で始まる)として確定する", async () => {
    const { request, process, exports } = await setup();
    const created = await request("csv");
    await process(created.id);
    const row = exports.rows.get(created.id);
    expect(row).toMatchObject({
      status: "ready",
      fileName: "habit-app-export-20261013.zip",
      contentType: "application/zip",
    });
    expect([...(row?.content ?? []).slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("許可リスト: 収集側が余計な項目(ハッシュ・token・内部 ID)を返しても、出力に現れない", async () => {
    const leaky = sampleBundle() as unknown as Record<string, unknown>;
    (leaky["account"] as Record<string, unknown>)["passwordHash"] = "argon2id$LEAKED-HASH";
    (leaky["account"] as Record<string, unknown>)["id"] = "42";
    (leaky["habits"] as Record<string, unknown>[])[0]!["userId"] = "42";
    (leaky["habits"] as Record<string, unknown>[])[0]!["sessionToken"] = "LEAKED-SESSION";
    leaky["sessions"] = [{ sessionToken: "LEAKED-SESSION" }];
    const { request, process, exports } = await setup({ bundle: leaky as unknown as ExportBundle });

    for (const format of ["json", "csv"] as const) {
      const created = await request(format);
      await process(created.id);
      const content = exports.rows.get(created.id)?.content ?? new Uint8Array();
      const text = decoder.decode(content);
      expect(text).not.toContain("LEAKED");
      expect(text).not.toContain("passwordHash");
      expect(text).not.toContain("userId");
    }
  });

  it("重複配送: 2 回目は何もせず、確定は 1 回だけ", async () => {
    const { request, process, exports } = await setup();
    const created = await request();
    await expect(process(created.id)).resolves.toBe("done");
    await expect(process(created.id)).resolves.toBe("done");
    expect(exports.completeCalls).toBe(1);
  });

  it("別の worker が処理中(lease 内)なら再配送に任せ、lease を過ぎたら引き継ぐ", async () => {
    const { request, process, exports, setNow, dataSource } = await setup();
    const created = await request();
    const row = exports.rows.get(created.id)!;
    // 別の worker が claim した状態を再現する。
    await exports.claim({ exportId: created.id, leaseSeconds: 300 });
    await expect(process(created.id)).resolves.toBe("retry");
    expect(dataSource.collected).toEqual([]);

    setNow(new Date(NOW.getTime() + 301_000));
    await expect(process(created.id)).resolves.toBe("done");
    expect(row.status).toBe("ready");
  });

  it("存在しない job は done(再配送しても直らない)", async () => {
    const { process } = await setup();
    await expect(process("00000000-0000-4000-8000-0000000000ff")).resolves.toBe("done");
  });

  it("収集の一時的な失敗は queued に戻して再配送し、上限に達したら failed(worker_error)", async () => {
    const { request, process, exports, dataSource } = await setup();
    const created = await request();
    dataSource.failures = 99;

    await expect(process(created.id, 1)).resolves.toBe("retry");
    expect(exports.rows.get(created.id)?.status).toBe("queued");
    await expect(process(created.id, DATA_EXPORT_MAX_RECEIVE - 1)).resolves.toBe("retry");

    await expect(process(created.id, DATA_EXPORT_MAX_RECEIVE)).resolves.toBe("done");
    expect(exports.rows.get(created.id)).toMatchObject({
      status: "failed",
      failureCode: "worker_error",
    });
    // 失敗の記録に、例外の内容を含めない。
    expect(JSON.stringify([...exports.rows.values()])).not.toContain("db down");
  });

  it("一時的な失敗のあとで成功すれば ready になる", async () => {
    const { request, process, exports, dataSource } = await setup();
    const created = await request();
    dataSource.failures = 1;
    await expect(process(created.id, 1)).resolves.toBe("retry");
    await expect(process(created.id, 2)).resolves.toBe("done");
    expect(exports.rows.get(created.id)?.status).toBe("ready");
  });

  it("生成の失敗は再試行せず failed(generation_failed)。内容を残さない", async () => {
    const broken = sampleBundle({
      weeklyReviews: [{ ...sampleBundle().weeklyReviews[0]!, summary: 10n as unknown as number }],
    });
    const { request, process, exports } = await setup({ bundle: broken });
    const created = await request("json");
    await expect(process(created.id)).resolves.toBe("done");
    expect(exports.rows.get(created.id)).toMatchObject({
      status: "failed",
      failureCode: "generation_failed",
      content: null,
    });
  });

  it("上限ちょうど(20 MiB)は成功し、1 バイトでも超えたら failed(too_large)", async () => {
    const withNote = (length: number) =>
      sampleBundle({
        dailyCheckIns: [{ ...sampleBundle().dailyCheckIns[0]!, note: "a".repeat(length) }],
      });
    const base = buildExportJson(withNote(0), NOW).length;
    const exactLength = DATA_EXPORT_MAX_BYTES - base;
    expect(buildExportJson(withNote(exactLength), NOW).length).toBe(DATA_EXPORT_MAX_BYTES);

    const ok = await setup({ bundle: withNote(exactLength) });
    const okExport = await ok.request("json");
    await ok.process(okExport.id);
    expect(ok.exports.rows.get(okExport.id)?.status).toBe("ready");

    const over = await setup({ bundle: withNote(exactLength + 1) });
    const overExport = await over.request("json");
    await over.process(overExport.id);
    expect(over.exports.rows.get(overExport.id)).toMatchObject({
      status: "failed",
      failureCode: "too_large",
      content: null,
    });
  });

  it("上限(20 MiB)を超えたら failed(too_large)で、何も保存しない", async () => {
    const huge = sampleBundle({
      dailyCheckIns: [
        { ...sampleBundle().dailyCheckIns[0]!, note: "あ".repeat(DATA_EXPORT_MAX_BYTES) },
      ],
    });
    const { request, process, exports } = await setup({ bundle: huge });
    const created = await request("json");
    await expect(process(created.id)).resolves.toBe("done");
    expect(exports.rows.get(created.id)).toMatchObject({
      status: "failed",
      failureCode: "too_large",
      content: null,
    });
    expect(exports.completeCalls).toBe(0);
  });

  it("データが空でも成功する(空の配列・ヘッダーのみ)", async () => {
    const empty = sampleBundle({
      profile: null,
      habits: [],
      habitEntries: [],
      dailyCheckIns: [],
      weeklyReviews: [],
      notificationSettings: null,
      aiResults: [],
    });
    const { request, process, exports } = await setup({ bundle: empty });
    for (const format of ["json", "csv"] as const) {
      const created = await request(format);
      await expect(process(created.id)).resolves.toBe("done");
      expect(exports.rows.get(created.id)?.status).toBe("ready");
    }
  });
});

describe("listDataExportsUseCase / effectiveExportStatus(EXP-003)", () => {
  it("自分の分だけを新しい順に最大 5 件返す", async () => {
    const { exports, list } = await setup();
    for (let i = 0; i < 7; i += 1) {
      const outcome = await exports.createIfAllowed({
        actorUserId: USER_A,
        format: "json",
        now: new Date(NOW.getTime() + i * 1000),
        windowStart: new Date(0),
        staleBefore: new Date(0),
        dailyLimit: 100,
        context: CONTEXT,
      });
      if (outcome.status === "created")
        await exports.fail({ exportId: outcome.export.id, failureCode: "worker_error" });
    }
    await exports.createIfAllowed({
      actorUserId: USER_B,
      format: "csv",
      now: NOW,
      windowStart: new Date(0),
      staleBefore: new Date(0),
      dailyLimit: 100,
      context: CONTEXT,
    });
    const items = await list();
    expect(items).toHaveLength(5);
    expect(items.every((item) => item.userId === USER_A)).toBe(true);
    expect(items.map((item) => item.createdAt.getTime())).toEqual(
      [...items.map((item) => item.createdAt.getTime())].sort((a, b) => b - a),
    );
  });

  it("期限を過ぎた ready は、定期ジョブの前でも expired として返す。境界は期限ちょうど", async () => {
    const { request, process, list, setNow } = await setup();
    const created = await request();
    await process(created.id);
    const expiresAt = NOW.getTime() + DATA_EXPORT_TTL_HOURS * HOUR_MS;

    setNow(new Date(expiresAt - 1));
    expect((await list())[0]?.status).toBe("ready");
    setNow(new Date(expiresAt));
    expect((await list())[0]?.status).toBe("expired");
  });

  it("effectiveExportStatus は ready 以外の状態を変えない", () => {
    const base = {
      id: "x",
      userId: "1",
      format: "json" as const,
      failureCode: null,
      byteSize: null,
      fileName: null,
      contentType: null,
      createdAt: NOW,
      completedAt: null,
      expiresAt: null,
    };
    for (const status of ["queued", "running", "failed", "expired"] as const) {
      expect(effectiveExportStatus({ ...base, status }, NOW)).toBe(status);
    }
  });
});

describe("downloadDataExportUseCase(EXP-004)", () => {
  it("自分の完成済み・期限内のエクスポートを返し、監査を残す", async () => {
    const { request, process, download, exports } = await setup();
    const created = await request();
    await process(created.id);
    const file = await download(created.id);
    expect(file).toMatchObject({
      fileName: "habit-app-export-20261013.json",
      contentType: "application/json; charset=utf-8",
    });
    expect(file.content.length).toBeGreaterThan(10);
    expect(exports.audit.at(-1)).toMatchObject({
      action: "user.export.downloaded",
      userId: USER_A,
      exportId: created.id,
    });
  });

  it("他人の ID と存在しない ID は区別せず ExportNotFoundError。監査も残らない", async () => {
    const { request, process, download, exports } = await setup();
    const created = await request();
    await process(created.id);
    await expect(download(created.id, USER_B)).rejects.toThrow(ExportNotFoundError);
    await expect(download("00000000-0000-4000-8000-0000000000ff")).rejects.toThrow(
      ExportNotFoundError,
    );
    expect(exports.audit.filter((a) => a.action === "user.export.downloaded")).toEqual([]);
  });

  it("完成前・失敗は ExportNotReadyError、期限後は ExportExpiredError", async () => {
    const { request, process, download, setNow, exports } = await setup();
    const queued = await request();
    await expect(download(queued.id)).rejects.toThrow(ExportNotReadyError);

    await process(queued.id);
    const expiresAt = NOW.getTime() + DATA_EXPORT_TTL_HOURS * HOUR_MS;
    setNow(new Date(expiresAt - 1));
    await expect(download(queued.id)).resolves.toBeDefined();
    setNow(new Date(expiresAt));
    await expect(download(queued.id)).rejects.toThrow(ExportExpiredError);

    const failed = await request();
    await exports.fail({ exportId: failed.id, failureCode: "worker_error" });
    await expect(download(failed.id)).rejects.toThrow(ExportNotReadyError);
  });

  it("監査の追記に失敗したらファイルを返さない(fail closed)", async () => {
    const { request, process, download, exports } = await setup();
    const created = await request();
    await process(created.id);
    exports.failDownloadAudit = true;
    await expect(download(created.id)).rejects.toThrow("audit failed");
  });
});

describe("cleanupExpiredDataExportsUseCase(EXP-007)", () => {
  it("期限切れの ready を expired にして成果物を消し、7 日を過ぎた failed/expired の行を削除する。冪等", async () => {
    const { request, process, cleanup, exports, setNow } = await setup();
    const created = await request();
    await process(created.id);

    setNow(new Date(NOW.getTime() + 25 * HOUR_MS));
    await expect(cleanup()).resolves.toEqual({ expired: 1, staleFailed: 0, deleted: 0 });
    expect(exports.rows.get(created.id)).toMatchObject({ status: "expired", content: null });
    await expect(cleanup()).resolves.toEqual({ expired: 0, staleFailed: 0, deleted: 0 });

    setNow(new Date(NOW.getTime() + 25 * HOUR_MS + 8 * 24 * HOUR_MS));
    await expect(cleanup()).resolves.toEqual({ expired: 0, staleFailed: 0, deleted: 1 });
    expect(exports.rows.size).toBe(0);
  });

  it("期限前の ready と、実行中の job は触らない", async () => {
    const { request, process, cleanup, exports, setNow } = await setup();
    const ready = await request();
    await process(ready.id);
    setNow(new Date(NOW.getTime() + 23 * HOUR_MS));
    await expect(cleanup()).resolves.toEqual({ expired: 0, staleFailed: 0, deleted: 0 });
    expect(exports.rows.get(ready.id)?.status).toBe("ready");
  });
});

describe("handleDataExportMessages(SQS の部分失敗)", () => {
  const record = (messageId: string, body: unknown, receive?: string) => ({
    messageId,
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(receive === undefined ? {} : { attributes: { ApproximateReceiveCount: receive } }),
  });

  it("成功した record は再配送せず、解釈できない message と retry だけを失敗として返す", async () => {
    const { request, processDeps, dataSource, exports } = await setup();
    const ok = await request();
    // 実行中の job を別に用意する(in_progress → retry)。
    const busy = await exports.createIfAllowed({
      actorUserId: USER_B,
      format: "json",
      now: NOW,
      windowStart: new Date(0),
      staleBefore: new Date(0),
      dailyLimit: 10,
      context: CONTEXT,
    });
    if (busy.status !== "created") throw new Error("setup");
    await exports.claim({ exportId: busy.export.id, leaseSeconds: 300 });

    const response = await handleDataExportMessages(processDeps, {
      Records: [
        record("m-ok", { version: 1, exportId: ok.id }),
        record("m-bad-json", "{not json"),
        record("m-bad-shape", { version: 2, exportId: ok.id }),
        record("m-extra", { version: 1, exportId: ok.id, userId: "1" }),
        record("m-busy", { version: 1, exportId: busy.export.id }),
      ],
    });
    expect(response.batchItemFailures.map((f) => f.itemIdentifier)).toEqual([
      "m-bad-json",
      "m-bad-shape",
      "m-extra",
      "m-busy",
    ]);
    expect(exports.rows.get(ok.id)?.status).toBe("ready");
    expect(dataSource.collected).toEqual([USER_A]);
  });

  it("1 件の例外が他の record を妨げない。受信回数は ApproximateReceiveCount から読む", async () => {
    const { request, processDeps, dataSource, exports } = await setup();
    const first = await request();
    dataSource.failures = 99;
    const response = await handleDataExportMessages(processDeps, {
      Records: [record("m-1", { version: 1, exportId: first.id }, String(DATA_EXPORT_MAX_RECEIVE))],
    });
    // 上限に達しているので failed(worker_error)で確定し、再配送は不要。
    expect(response.batchItemFailures).toEqual([]);
    expect(exports.rows.get(first.id)).toMatchObject({
      status: "failed",
      failureCode: "worker_error",
    });
  });
});

describe("性質", () => {
  it("性質: 任意の回数の重複配送でも、確定は 1 回で、成果物は変わらない", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (deliveries) => {
        const { request, process, exports } = await setup();
        const created = await request();
        for (let i = 0; i < deliveries; i += 1) await process(created.id, i + 1);
        expect(exports.completeCalls).toBe(1);
        expect(exports.rows.get(created.id)?.status).toBe("ready");
      }),
      { numRuns: 20 },
    );
  });
});
