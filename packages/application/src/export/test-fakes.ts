import type {
  DataExportFailureCode,
  DataExportFormat,
  DataExportStatus,
  ExportBundle,
} from "@habit-app/domain";
import { isExportExpired } from "@habit-app/domain";

import type {
  CompleteDataExportInput,
  DataExportQueuePort,
  DataExportRecord,
  DataExportRepositoryPort,
  ExportDataSourcePort,
} from "./ports";

/**
 * データエクスポート use case の Unit Test 専用 fake。DB の部分 unique index・条件付き更新・transaction は
 * 持たず、port が約束する意味(状態遷移の条件、所有者条件、監査が先)の検証を目的とする。
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface FakeRow extends Mutable<DataExportRecord> {
  leaseUntil: Date | null;
  content: Uint8Array | null;
  updatedAt: Date;
}

export interface FakeAudit {
  readonly action: "user.export.requested" | "user.export.downloaded";
  readonly userId: string;
  readonly exportId: string;
  readonly requestId: string;
}

export interface FakeDataExportRepository extends DataExportRepositoryPort {
  readonly rows: Map<string, FakeRow>;
  readonly audit: FakeAudit[];
  readonly calls: { method: string; actorUserId?: string; exportId?: string }[];
  /** true にすると、ダウンロードの監査の追記が失敗する(fail closed の検証)。 */
  failDownloadAudit: boolean;
  /** 時刻(lease の判定に使う)。テストが進める。 */
  clock: Date;
  completeCalls: number;
}

export function createFakeDataExportRepository(
  existingUserIds: readonly string[],
  clock: Date = new Date("2026-10-13T03:00:00.000Z"),
): FakeDataExportRepository {
  const users = new Set(existingUserIds);
  const rows = new Map<string, FakeRow>();
  const audit: FakeAudit[] = [];
  const calls: FakeDataExportRepository["calls"] = [];
  let sequence = 0;

  const state = {
    rows,
    audit,
    calls,
    failDownloadAudit: false,
    clock,
    completeCalls: 0,
  };

  function toRecord(row: FakeRow): DataExportRecord {
    return {
      id: row.id,
      userId: row.userId,
      format: row.format,
      status: row.status,
      failureCode: row.failureCode,
      byteSize: row.byteSize,
      fileName: row.fileName,
      contentType: row.contentType,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      expiresAt: row.expiresAt,
    };
  }

  const repository: FakeDataExportRepository = {
    get rows() {
      return state.rows;
    },
    get audit() {
      return state.audit;
    },
    get calls() {
      return state.calls;
    },
    get failDownloadAudit() {
      return state.failDownloadAudit;
    },
    set failDownloadAudit(value: boolean) {
      state.failDownloadAudit = value;
    },
    get clock() {
      return state.clock;
    },
    set clock(value: Date) {
      state.clock = value;
    },
    get completeCalls() {
      return state.completeCalls;
    },
    set completeCalls(value: number) {
      state.completeCalls = value;
    },

    async createIfAllowed({
      actorUserId,
      format,
      now,
      windowStart,
      dailyLimit,
      staleBefore,
      context,
    }) {
      calls.push({ method: "createIfAllowed", actorUserId });
      if (!users.has(actorUserId)) return { status: "not_found" };
      const own = [...rows.values()].filter((row) => row.userId === actorUserId);
      // 停止したとみなす job(長く更新されない queued/running)は失敗にして、作成を妨げない。
      for (const row of own) {
        if (
          (row.status === "queued" || row.status === "running") &&
          row.updatedAt.getTime() <= staleBefore.getTime()
        ) {
          row.status = "failed";
          row.failureCode = "worker_error";
          row.leaseUntil = null;
        }
      }
      if (own.some((row) => row.status === "queued" || row.status === "running")) {
        return { status: "in_progress" };
      }
      const recent = own.filter((row) => row.createdAt.getTime() >= windowStart.getTime());
      if (recent.length >= dailyLimit) return { status: "rate_limited" };

      for (const row of own) {
        if (row.status === "ready") {
          row.status = "expired";
          row.content = null;
        }
      }
      sequence += 1;
      const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      const row: FakeRow = {
        id,
        userId: actorUserId,
        format,
        status: "queued",
        failureCode: null,
        byteSize: null,
        fileName: null,
        contentType: null,
        createdAt: now,
        completedAt: null,
        expiresAt: null,
        leaseUntil: null,
        content: null,
        updatedAt: now,
      };
      rows.set(id, row);
      audit.push({
        action: "user.export.requested",
        userId: actorUserId,
        exportId: id,
        requestId: context.requestId,
      });
      return { status: "created", export: toRecord(row) };
    },

    async list({ actorUserId, limit }) {
      calls.push({ method: "list", actorUserId });
      return [...rows.values()]
        .filter((row) => row.userId === actorUserId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map(toRecord);
    },

    async claim({ exportId, leaseSeconds }) {
      calls.push({ method: "claim", exportId });
      const row = rows.get(exportId);
      if (row === undefined) return { status: "not_found" };
      const leaseExpired =
        row.leaseUntil !== null && row.leaseUntil.getTime() <= state.clock.getTime();
      if (row.status === "queued" || (row.status === "running" && leaseExpired)) {
        row.status = "running";
        row.leaseUntil = new Date(state.clock.getTime() + leaseSeconds * 1000);
        return { status: "claimed", export: toRecord(row) };
      }
      return row.status === "running" ? { status: "in_progress" } : { status: "finished" };
    },

    async complete(input: CompleteDataExportInput) {
      calls.push({ method: "complete", exportId: input.exportId });
      state.completeCalls += 1;
      const row = rows.get(input.exportId);
      if (row === undefined || row.status !== "running") return "lost";
      row.status = "ready";
      row.content = input.content;
      row.byteSize = input.content.length;
      row.fileName = input.fileName;
      row.contentType = input.contentType;
      row.completedAt = input.completedAt;
      row.expiresAt = input.expiresAt;
      row.leaseUntil = null;
      return "completed";
    },

    async fail({
      exportId,
      failureCode,
    }: {
      exportId: string;
      failureCode: DataExportFailureCode;
    }) {
      calls.push({ method: "fail", exportId });
      const row = rows.get(exportId);
      if (row === undefined || (row.status !== "queued" && row.status !== "running")) return;
      row.status = "failed";
      row.failureCode = failureCode;
      row.leaseUntil = null;
    },

    async release({ exportId }) {
      calls.push({ method: "release", exportId });
      const row = rows.get(exportId);
      if (row === undefined || row.status !== "running") return;
      row.status = "queued";
      row.leaseUntil = null;
    },

    async readArtifact({ actorUserId, exportId, now, context }) {
      calls.push({ method: "readArtifact", actorUserId, exportId });
      const row = rows.get(exportId);
      if (row === undefined || row.userId !== actorUserId) return { status: "not_found" };
      if (row.status === "expired") return { status: "expired" };
      if (row.status !== "ready") return { status: "not_ready" };
      if (row.expiresAt !== null && isExportExpired(row.expiresAt, now))
        return { status: "expired" };
      // 監査が先。失敗したら成果物を読まない。
      if (state.failDownloadAudit) throw new Error("audit failed");
      audit.push({
        action: "user.export.downloaded",
        userId: actorUserId,
        exportId,
        requestId: context.requestId,
      });
      return { status: "ok", export: toRecord(row), content: row.content ?? new Uint8Array(0) };
    },

    async expireDue({ now, limit }) {
      let count = 0;
      for (const row of rows.values()) {
        if (count >= limit) break;
        if (
          row.status === "ready" &&
          row.expiresAt !== null &&
          isExportExpired(row.expiresAt, now)
        ) {
          row.status = "expired";
          row.content = null;
          row.updatedAt = now;
          count += 1;
        }
      }
      return count;
    },

    async failStale({ cutoff, limit }) {
      let count = 0;
      for (const row of rows.values()) {
        if (count >= limit) break;
        if (
          (row.status === "queued" || row.status === "running") &&
          row.updatedAt.getTime() <= cutoff.getTime()
        ) {
          row.status = "failed";
          row.failureCode = "worker_error";
          row.leaseUntil = null;
          count += 1;
        }
      }
      return count;
    },

    async deleteClosed({ cutoff, limit }) {
      let count = 0;
      for (const [id, row] of [...rows.entries()]) {
        if (count >= limit) break;
        if (
          (row.status === "failed" || row.status === "expired") &&
          row.updatedAt.getTime() <= cutoff.getTime()
        ) {
          rows.delete(id);
          count += 1;
        }
      }
      return count;
    },
  };
  return repository;
}

export interface FakeQueue extends DataExportQueuePort {
  /** 投入された message をそのまま保持する(余計な項目が混ざったときに検知できるように)。 */
  readonly messages: unknown[];
  failNext: boolean;
}

export function createFakeQueue(): FakeQueue {
  const messages: FakeQueue["messages"] = [];
  const queue: FakeQueue = {
    messages,
    failNext: false,
    async enqueue(message) {
      if (queue.failNext) {
        queue.failNext = false;
        throw new Error("queue down");
      }
      messages.push(message);
    },
  };
  return queue;
}

export interface FakeDataSource extends ExportDataSourcePort {
  bundle: ExportBundle;
  failures: number;
  readonly collected: string[];
}

/** 最初の `failures` 回は例外を投げ、以降は `bundle` を返す。 */
export function createFakeDataSource(bundle: ExportBundle): FakeDataSource {
  const collected: string[] = [];
  const source: FakeDataSource = {
    bundle,
    failures: 0,
    collected,
    async collect({ userId }) {
      collected.push(userId);
      if (source.failures > 0) {
        source.failures -= 1;
        throw new Error("db down");
      }
      return source.bundle;
    },
  };
  return source;
}

/** テスト用の架空データ(個人情報ではない)。 */
export function sampleBundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  const habitId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  return {
    account: { email: "taro@example.test", createdAt: "2026-09-01T00:00:00.000Z" },
    profile: { displayName: "たろう", timezone: "Asia/Tokyo", locale: "ja", weekStartsOn: 1 },
    habits: [
      {
        id: habitId,
        kind: "build",
        name: "散歩",
        purpose: "健康のため",
        cue: "朝食のあと",
        minimumAction: "玄関を出る",
        replacementAction: null,
        status: "active",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        scheduleVersions: [
          {
            habitId,
            effectiveFrom: "2026-09-02",
            effectiveTo: null,
            daysOfWeek: [1, 2, 3, 4, 5],
            targetCount: 1,
          },
        ],
      },
    ],
    habitEntries: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        habitId,
        date: "2026-09-03",
        status: "success",
        quantity: 1,
        note: "=SUM(1,1)",
        source: "web",
        createdAt: "2026-09-03T01:00:00.000Z",
        updatedAt: "2026-09-03T01:00:00.000Z",
      },
    ],
    dailyCheckIns: [
      {
        date: "2026-09-03",
        mood: 4,
        difficulty: 2,
        note: '良い日,"引用"\n改行',
        createdAt: "2026-09-03T12:00:00.000Z",
        updatedAt: "2026-09-03T12:00:00.000Z",
      },
    ],
    weeklyReviews: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        weekStart: "2026-08-31",
        timezoneSnapshot: "Asia/Tokyo",
        summary: { scheduled: 5, success: 4 },
        reflection: "よくできた",
        status: "completed",
        completedAt: "2026-09-07T00:00:00.000Z",
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    notificationSettings: {
      enabled: true,
      localTime: "20:00",
      timezone: "Asia/Tokyo",
      quietHours: { start: "22:00", end: "07:00" },
    },
    aiResults: [],
    ...overrides,
  };
}

export type { DataExportFormat, DataExportStatus };
