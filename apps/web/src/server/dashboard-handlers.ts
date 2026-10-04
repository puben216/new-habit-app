import { UserNotFoundError } from "@habit-app/application";
import type { Dashboard, GetDashboardInput } from "@habit-app/application";
import type { DashboardResponse } from "@habit-app/contracts";

import { jsonResponse, problemResponse, unauthorizedResponse } from "./habit-http";

/**
 * `/api/v1/dashboard` の route handler 本体(docs/specs/statistics-dashboard.md)。
 * route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・use case 呼び出し・HTTP 変換のみを行う。
 * 読み取り専用で query を受け付けないため、Origin 検証・入力検証はない。
 */

export interface DashboardUseCases {
  get(input: GetDashboardInput): Promise<Dashboard>;
}

export interface DashboardHandlerDeps {
  /** session から actor の user ID を取得する。未認証は null。 */
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  readonly useCases: DashboardUseCases;
}

export interface DashboardHandlers {
  get(request: Request): Promise<Response>;
}

function toDashboardResponse(dashboard: Dashboard): DashboardResponse {
  return {
    date: dashboard.date,
    timezone: dashboard.timezone,
    overall: dashboard.overall,
    habits: dashboard.habits.map(({ habit, statistics }) => ({
      // 習慣の自由記述(purpose/cue 等)は含めず、識別に必要な項目のみ返す。
      habit: { id: habit.id, kind: habit.kind, name: habit.name },
      currentStreak: statistics.currentStreak,
      longestStreak: statistics.longestStreak,
      last7Days: statistics.last7Days,
      last30Days: statistics.last30Days,
    })),
  };
}

export function createDashboardHandlers(deps: DashboardHandlerDeps): DashboardHandlers {
  return {
    async get(request) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      try {
        const dashboard = await deps.useCases.get({ actorUserId });
        return jsonResponse(200, toDashboardResponse(dashboard));
      } catch (error) {
        if (error instanceof UserNotFoundError) {
          return problemResponse(404, {
            code: "user_not_found",
            message: "ユーザーが見つかりません",
          });
        }
        throw error;
      }
    },
  };
}
