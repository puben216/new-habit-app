import { describe, expect, it } from "vitest";

import {
  getUserOverviewUseCase,
  listAiJobFailuresUseCase,
  listNotificationFailuresUseCase,
  searchUserByEmailUseCase,
} from "./admin-read";
import type { AdminReadDeps } from "./admin-read";
import { createFakeAdminRead, createFakeAuditLog } from "./test-fakes";

const NOW = new Date("2026-10-10T03:00:00.000Z");
const ADMIN = { adminId: "10", adminPublicId: "pub-admin-10" };
const CONTEXT = { requestId: "req-7", ipHash: "iphash" };
const base = { admin: ADMIN, context: CONTEXT };

function setup() {
  const read = createFakeAdminRead();
  const audit = createFakeAuditLog();
  const deps: AdminReadDeps = { read, audit, now: () => NOW };
  return { read, audit, deps };
}

const delivery = (id: number, status = "failed") => ({
  id: String(id),
  userPublicId: `user-${id}`,
  status,
  failureCode: "rejected",
  attemptCount: 1,
  scheduledAt: NOW,
  localDate: "2026-10-10",
  updatedAt: NOW,
});

describe("searchUserByEmailUseCase", () => {
  it("email を正規化して完全一致で検索し、マスクした結果だけを返す。email は監査に残さない", async () => {
    const { deps, read, audit } = setup();
    read.users = [
      { publicId: "pub-1", email: "user@example.test", status: "active", createdAt: NOW },
    ];
    const items = await searchUserByEmailUseCase(deps, { ...base, email: "  USER@Example.test " });
    expect(items).toEqual([
      { publicId: "pub-1", emailMasked: "u***@example.test", status: "active", createdAt: NOW },
    ]);
    expect(JSON.stringify(items)).not.toContain("user@example.test");
    expect(audit.entries).toEqual([
      {
        actor: "admin:pub-admin-10",
        action: "admin.user.search",
        targetType: "user",
        targetPublicId: null,
        requestId: "req-7",
        ipHash: "iphash",
        now: NOW,
      },
    ]);
    expect(JSON.stringify(audit.entries)).not.toMatch(/example\.test|user@/);
  });

  it("一致しなければ空(部分一致はしない)", async () => {
    const { deps, read } = setup();
    read.users = [
      { publicId: "pub-1", email: "user@example.test", status: "active", createdAt: NOW },
    ];
    expect(await searchUserByEmailUseCase(deps, { ...base, email: "user" })).toEqual([]);
    expect(await searchUserByEmailUseCase(deps, { ...base, email: "@example.test" })).toEqual([]);
  });

  it("監査の追記に失敗したら検索を行わない(fail closed)", async () => {
    const { deps, read, audit } = setup();
    audit.failing = true;
    await expect(
      searchUserByEmailUseCase(deps, { ...base, email: "a@example.test" }),
    ).rejects.toThrow("audit store unavailable");
    expect(read.calls).toEqual([]);
  });

  it("監査は閲覧より先に追記される", async () => {
    const { deps, read, audit } = setup();
    const order: string[] = [];
    const originalAppend = audit.append.bind(audit);
    audit.append = async (entry) => {
      order.push("audit");
      return originalAppend(entry);
    };
    const originalFind = read.findUserByEmail.bind(read);
    read.findUserByEmail = async (email) => {
      order.push("read");
      return originalFind(email);
    };
    await searchUserByEmailUseCase(deps, { ...base, email: "a@example.test" });
    expect(order).toEqual(["audit", "read"]);
  });
});

describe("getUserOverviewUseCase", () => {
  const overview = {
    publicId: "pub-1",
    email: "user@example.test",
    status: "active",
    createdAt: NOW,
    emailVerified: true,
    suppressed: true,
    notificationDeliveries: { failed: 1, sent: 3 },
    aiJobs: { failed: 2 },
  };

  it("概要を返し(email はマスク)、対象の公開 ID を監査に残す。集計期間は直近 30 日", async () => {
    const { deps, read, audit } = setup();
    read.overviews.set("pub-1", overview);
    let since: Date | undefined;
    const original = read.getUserOverview.bind(read);
    read.getUserOverview = async (input) => {
      since = input.since;
      return original(input);
    };
    const result = await getUserOverviewUseCase(deps, { ...base, publicId: "pub-1" });
    expect(result).toEqual({
      publicId: "pub-1",
      emailMasked: "u***@example.test",
      status: "active",
      createdAt: NOW,
      emailVerified: true,
      notification: { suppressed: true, deliveries: { failed: 1, sent: 3 } },
      aiJobs: { failed: 2 },
    });
    expect(JSON.stringify(result)).not.toContain("user@example.test");
    expect(since?.toISOString()).toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
    expect(audit.entries[0]).toMatchObject({ action: "admin.user.view", targetPublicId: "pub-1" });
  });

  it("存在しないユーザーは null。存在しなくても閲覧の試行は監査に残る", async () => {
    const { deps, audit } = setup();
    expect(await getUserOverviewUseCase(deps, { ...base, publicId: "missing" })).toBeNull();
    expect(audit.entries).toHaveLength(1);
  });
});

describe("listNotificationFailuresUseCase", () => {
  it("新しい順に最大 limit 件と nextCursor を返し、状態の既定は failed/expired/suppressed", async () => {
    const { deps, read, audit } = setup();
    read.notificationFailures = [
      delivery(1),
      delivery(2, "expired"),
      delivery(3, "suppressed"),
      delivery(4, "sent"),
      delivery(5),
    ];
    const page1 = await listNotificationFailuresUseCase(deps, { ...base, limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(["5", "3"]);
    expect(page1.nextCursor).toBe("3");
    const page2 = await listNotificationFailuresUseCase(deps, {
      ...base,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((i) => i.id)).toEqual(["2", "1"]);
    expect(page2.nextCursor).toBeNull();
    expect(audit.entries.map((e) => e.action)).toEqual([
      "admin.notifications.list",
      "admin.notifications.list",
    ]);
  });

  it("status で絞り込める。limit は 1〜50 に丸め、既定は 20", async () => {
    const { deps, read } = setup();
    read.notificationFailures = Array.from({ length: 60 }, (_, i) => delivery(i + 1));
    const onlyExpired = await listNotificationFailuresUseCase(deps, {
      ...base,
      statuses: ["expired"],
    });
    expect(onlyExpired.items).toEqual([]);
    expect((await listNotificationFailuresUseCase(deps, base)).items).toHaveLength(20);
    expect(
      (await listNotificationFailuresUseCase(deps, { ...base, limit: 1000 })).items,
    ).toHaveLength(50);
    expect((await listNotificationFailuresUseCase(deps, { ...base, limit: 0 })).items).toHaveLength(
      1,
    );
  });

  it("返す項目は allowlist のみ(email・設定の中身を含まない)", async () => {
    const { deps, read } = setup();
    read.notificationFailures = [delivery(1)];
    const [item] = (await listNotificationFailuresUseCase(deps, base)).items;
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "attemptCount",
      "failureCode",
      "id",
      "localDate",
      "scheduledAt",
      "status",
      "updatedAt",
      "userPublicId",
    ]);
  });

  it("監査に失敗したら一覧を取得しない", async () => {
    const { deps, read, audit } = setup();
    audit.failing = true;
    await expect(listNotificationFailuresUseCase(deps, base)).rejects.toThrow();
    expect(read.calls).toEqual([]);
  });
});

describe("listAiJobFailuresUseCase", () => {
  const job = (id: number, status = "failed") => ({
    cursorId: String(id),
    publicId: `job-${id}`,
    userPublicId: `user-${id}`,
    kind: "habit_design",
    status,
    failureCode: "timeout",
    provider: "fake",
    model: "fake-1",
    promptVersion: "v1",
    createdAt: NOW,
  });

  it("failed/fallback を新しい順に返し、内部の cursor ID は応答に含めない", async () => {
    const { deps, read, audit } = setup();
    read.aiJobFailures = [job(1), job(2, "fallback"), job(3, "succeeded")];
    const page = await listAiJobFailuresUseCase(deps, { ...base, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ publicId: "job-2" });
    expect(Object.keys(page.items[0] ?? {})).not.toContain("cursorId");
    expect(page.nextCursor).toBe("2");
    expect(audit.entries[0]?.action).toBe("admin.ai_jobs.list");
  });

  it("データがなければ空の一覧", async () => {
    const { deps } = setup();
    expect(await listAiJobFailuresUseCase(deps, base)).toEqual({ items: [], nextCursor: null });
  });
});
