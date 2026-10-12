import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adminAiJobsQueryKey,
  adminNotificationsQueryKey,
  adminUserQueryKey,
  getAdminUser,
  listNotificationFailures,
  searchUsers,
  verifyMfa,
} from "./admin-api";

const EMAIL = "someone@example.test";
const PUBLIC_ID = "11111111-2222-4333-8444-555555555555";

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("admin API client", () => {
  it("queryKey に email を含めない(検索は mutation で行う。ADS-INV-003)", () => {
    const keys = [
      adminUserQueryKey(PUBLIC_ID),
      adminNotificationsQueryKey(undefined),
      adminNotificationsQueryKey("failed"),
      adminAiJobsQueryKey("fallback"),
    ];
    for (const key of keys) expect(JSON.stringify(key)).not.toContain("@");
  });

  it("MFA の検証は POST /admin/mfa/verify に { code } だけを送る", async () => {
    const fetchMock = stubFetch({ status: "verified" });
    await expect(verifyMfa("123456")).resolves.toEqual({ status: "verified" });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/admin/mfa/verify");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ code: "123456" });
  });

  it("検索は GET で email を query に載せ、応答を schema で検証する", async () => {
    const fetchMock = stubFetch({
      items: [
        {
          publicId: PUBLIC_ID,
          emailMasked: "s***@example.test",
          status: "active",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    const result = await searchUsers(EMAIL);
    expect(result.items[0]?.emailMasked).toBe("s***@example.test");
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/admin/users?email=${encodeURIComponent(EMAIL)}`);
    expect(init.method).toBe("GET");
  });

  it("契約に合わない応答は invalid_response として拒否する", async () => {
    stubFetch({
      items: [{ publicId: "not-a-uuid", emailMasked: "x", status: "a", createdAt: "x" }],
    });
    await expect(searchUsers(EMAIL)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("概要は encode した ID で GET する。UUID でない ID は path 検証または 404 に任せる", async () => {
    const fetchMock = stubFetch({ error: "x" }, 404);
    await expect(getAdminUser("../etc/passwd")).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("一覧は status と cursor だけを query に載せる", async () => {
    const fetchMock = stubFetch({ items: [], nextCursor: null });
    await listNotificationFailures("failed", "42");
    await listNotificationFailures(undefined, undefined);
    const paths = fetchMock.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(paths).toEqual([
      "/api/v1/admin/operations/notifications?status=failed&cursor=42",
      "/api/v1/admin/operations/notifications",
    ]);
  });
});
