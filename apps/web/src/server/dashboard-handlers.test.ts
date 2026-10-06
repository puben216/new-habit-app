import { UserNotFoundError } from "@habit-app/application";
import type { Dashboard } from "@habit-app/application";
import { dashboardResponseSchema } from "@habit-app/contracts";
import { createHabit } from "@habit-app/domain";
import type { WindowStatistics } from "@habit-app/domain";
import { describe, expect, it, vi } from "vitest";

import { createDashboardHandlers } from "./dashboard-handlers";
import type { DashboardUseCases } from "./dashboard-handlers";

const ORIGIN = "https://app.example.test";
const HABIT_ID = "5d1b6d4e-6b1c-4a0e-9e0e-7a0f8d5b8c11";

const habit = createHabit({
  id: HABIT_ID,
  kind: "build",
  name: "水を飲む",
  purpose: "健康維持(これは応答に含めない)",
  cue: "起床直後(これは応答に含めない)",
  minimumAction: "コップ1杯",
  initialSchedule: {
    effectiveFrom: "2025-01-01",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    targetCount: 1,
  },
});

const window: WindowStatistics = {
  from: "2026-01-08",
  to: "2026-01-14",
  scheduled: 7,
  success: 4,
  missed: 2,
  skipped: 0,
  pending: 1,
  successRate: 4 / 6,
};

const dashboard: Dashboard = {
  date: "2026-01-14",
  timezone: "Asia/Tokyo",
  overall: { last7Days: window, last30Days: { ...window, from: "2025-12-16" } },
  habits: [
    {
      habit,
      statistics: { currentStreak: 3, longestStreak: 10, last7Days: window, last30Days: window },
    },
  ],
};

function setup(options: { actor?: string | null } = {}) {
  const useCases = {
    get: vi.fn<DashboardUseCases["get"]>(async () => dashboard),
  };
  const handlers = createDashboardHandlers({
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    useCases,
  });
  return { handlers, useCases };
}

function getRequest(query = ""): Request {
  return new Request(`${ORIGIN}/api/v1/dashboard${query}`);
}

describe("GET /dashboard", () => {
  it("200 で統計を返し、契約 schema に適合し、習慣の自由記述と内部 ID を含めない", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.get(getRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body: unknown = await response.json();
    expect(dashboardResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      date: "2026-01-14",
      habits: [{ habit: { id: HABIT_ID, name: "水を飲む" }, currentStreak: 3, longestStreak: 10 }],
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("これは応答に含めない");
    expect(text).not.toContain("userId");
    expect(useCases.get).toHaveBeenCalledWith({ actorUserId: "42" });
  });

  it("空状態(習慣なし・成功率 null)も 200", async () => {
    const { handlers, useCases } = setup();
    useCases.get.mockResolvedValueOnce({
      ...dashboard,
      overall: {
        last7Days: {
          ...window,
          scheduled: 0,
          success: 0,
          missed: 0,
          pending: 0,
          successRate: null,
        },
        last30Days: {
          ...window,
          scheduled: 0,
          success: 0,
          missed: 0,
          pending: 0,
          successRate: null,
        },
      },
      habits: [],
    });
    const response = await handlers.get(getRequest());
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(dashboardResponseSchema.safeParse(body).success).toBe(true);
  });

  it("未認証は 401 で use case を呼ばない", async () => {
    const { handlers, useCases } = setup({ actor: null });
    const response = await handlers.get(getRequest());
    expect(response.status).toBe(401);
    expect(useCases.get).not.toHaveBeenCalled();
  });

  it("query で user を指定しても無視し、actor は session のものだけを使う", async () => {
    const { handlers, useCases } = setup();
    await handlers.get(getRequest("?userId=999&from=2020-01-01"));
    expect(useCases.get).toHaveBeenCalledWith({ actorUserId: "42" });
  });

  it("user が存在しなければ 404 user_not_found", async () => {
    const { handlers, useCases } = setup();
    useCases.get.mockRejectedValueOnce(new UserNotFoundError());
    const response = await handlers.get(getRequest());
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("user_not_found");
  });

  it("未知のエラーは握りつぶさず再 throw する(内部詳細を応答に出さない)", async () => {
    const { handlers, useCases } = setup();
    useCases.get.mockRejectedValueOnce(new Error("boom"));
    await expect(handlers.get(getRequest())).rejects.toThrow("boom");
  });
});
