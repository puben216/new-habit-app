import { EntryDateOutOfRangeError, HabitNotScheduledError } from "@habit-app/application";
import type {
  HabitEntryRecord,
  TodaySchedule,
  UpsertHabitEntryInput,
} from "@habit-app/application";
import { habitEntryDateParamSchema, upsertHabitEntryRequestSchema } from "@habit-app/contracts";
import type { HabitEntryResponse, TodayScheduleResponse } from "@habit-app/contracts";
import { InvalidHabitEntryError } from "@habit-app/domain";

import {
  habitNotFoundResponse,
  invalidOriginResponse,
  isTrustedOrigin,
  jsonResponse,
  mapHabitError,
  problemResponse,
  readJsonBody,
  unauthorizedResponse,
  validationFailedResponse,
} from "./habit-http";

/**
 * `/api/v1/schedule/today` と `/api/v1/habits/{habitId}/entries/{date}` の route handler 本体
 * (docs/specs/habit-entry.md)。route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 */

export interface EntryUseCases {
  getToday(input: { actorUserId: string }): Promise<TodaySchedule>;
  upsert(input: UpsertHabitEntryInput): Promise<HabitEntryRecord>;
}

export interface EntryHandlerDeps {
  /** session から actor の user ID を取得する。未認証は null。 */
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  /** 状態変更メソッドで許可する Origin(例: `https://app.example.com`)。 */
  readonly allowedOrigin: string;
  readonly useCases: EntryUseCases;
}

export interface EntryRouteParams {
  readonly habitId: string;
  readonly date: string;
}

export interface EntryHandlers {
  today(request: Request): Promise<Response>;
  upsert(request: Request, params: EntryRouteParams): Promise<Response>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * use case が投げたエラーを HTTP 応答へ変換する。tracking 固有のエラーを先に判定し、
 * 習慣の不存在・アーカイブ済み等の共通エラーは habits の変換へ委ねる。未知のエラーは null。
 */
function mapEntryError(error: unknown): Response | null {
  if (error instanceof EntryDateOutOfRangeError) {
    return problemResponse(422, {
      code: "entry_date_out_of_range",
      message: "記録できるのは今日から過去 7 日までの日付です",
      fieldErrors: { date: ["記録できる日付の範囲外です"] },
    });
  }
  if (error instanceof HabitNotScheduledError) {
    return problemResponse(422, {
      code: "habit_not_scheduled",
      message: "この日は習慣の予定がありません",
      fieldErrors: { date: ["この日は予定がありません"] },
    });
  }
  if (error instanceof InvalidHabitEntryError) {
    // メッセージは項目名・数値のみで自由記述を含まない。
    return problemResponse(422, {
      code: "invalid_habit_entry",
      message: "記録の内容が不正です",
      fieldErrors: { [error.field]: [error.message] },
    });
  }
  return mapHabitError(error);
}

function toEntryResponse(record: HabitEntryRecord): HabitEntryResponse {
  return {
    habitId: record.habitId,
    date: record.date,
    status: record.status,
    quantity: record.quantity,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toTodayResponse(today: TodaySchedule): TodayScheduleResponse {
  return {
    date: today.date,
    timezone: today.timezone,
    items: today.items.map((item) => ({
      habit: {
        id: item.habit.id,
        kind: item.habit.kind,
        name: item.habit.name,
        cue: item.habit.cue,
        minimumAction: item.habit.minimumAction,
        replacementAction: item.habit.replacementAction,
      },
      targetCount: item.targetCount,
      entry:
        item.entry === null
          ? null
          : {
              status: item.entry.status,
              quantity: item.entry.quantity,
              updatedAt: item.entry.updatedAt.toISOString(),
            },
    })),
  };
}

export function createEntryHandlers(deps: EntryHandlerDeps): EntryHandlers {
  async function run(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      const response = mapEntryError(error);
      if (response === null) throw error;
      return response;
    }
  }

  return {
    async today(request) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      return run(async () => {
        const today = await deps.useCases.getToday({ actorUserId });
        return jsonResponse(200, toTodayResponse(today));
      });
    },

    async upsert(request, params) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();
      if (!UUID_PATTERN.test(params.habitId)) return habitNotFoundResponse();

      const date = habitEntryDateParamSchema.safeParse(params.date);
      if (!date.success) {
        return validationFailedResponse({
          date: ["日付は YYYY-MM-DD 形式の実在する暦日で指定してください"],
        });
      }

      const parsed = await readJsonBody(request, upsertHabitEntryRequestSchema);
      if (!parsed.ok) return parsed.response;

      return run(async () => {
        const record = await deps.useCases.upsert({
          actorUserId,
          habitId: params.habitId,
          date: date.data,
          status: parsed.data.status,
          quantity: parsed.data.quantity,
        });
        return jsonResponse(200, toEntryResponse(record));
      });
    },
  };
}
