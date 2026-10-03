import {
  archiveHabitRequestSchema,
  createHabitRequestSchema,
  listHabitsQuerySchema,
  toFieldErrors,
  updateHabitRequestSchema,
} from "@habit-app/contracts";
import type { HabitListResponse } from "@habit-app/contracts";
import type {
  ArchiveHabitUseCaseInput,
  CreateHabitUseCaseInput,
  GetHabitInput,
  HabitRecord,
  ListHabitsInput,
  ListHabitsResult,
  UpdateHabitUseCaseInput,
} from "@habit-app/application";
import type { UpdateHabitDetailsInput } from "@habit-app/domain";

import {
  habitNotFoundResponse,
  invalidOriginResponse,
  isTrustedOrigin,
  jsonResponse,
  mapHabitError,
  readJsonBody,
  toHabitResponse,
  unauthorizedResponse,
  validationFailedResponse,
} from "./habit-http";

/**
 * `/api/v1/habits` の route handler 本体(docs/specs/habit-api.md)。
 * route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 */

export interface HabitUseCases {
  create(input: CreateHabitUseCaseInput): Promise<HabitRecord>;
  list(input: ListHabitsInput): Promise<ListHabitsResult>;
  get(input: GetHabitInput): Promise<HabitRecord>;
  update(input: UpdateHabitUseCaseInput): Promise<HabitRecord>;
  archive(input: ArchiveHabitUseCaseInput): Promise<HabitRecord>;
}

export interface HabitHandlerDeps {
  /** session から actor の user ID を取得する。未認証は null。 */
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  /** 状態変更メソッドで許可する Origin(例: `https://app.example.com`)。 */
  readonly allowedOrigin: string;
  readonly useCases: HabitUseCases;
}

export interface HabitRouteParams {
  readonly habitId: string;
}

export interface HabitHandlers {
  create(request: Request): Promise<Response>;
  list(request: Request): Promise<Response>;
  get(request: Request, params: HabitRouteParams): Promise<Response>;
  update(request: Request, params: HabitRouteParams): Promise<Response>;
  archive(request: Request, params: HabitRouteParams): Promise<Response>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createHabitHandlers(deps: HabitHandlerDeps): HabitHandlers {
  /** use case 呼び出しを包み、既知のエラーを HTTP 応答へ変換する。未知のエラーは再 throw する。 */
  async function run(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      const response = mapHabitError(error);
      if (response === null) throw error;
      return response;
    }
  }

  return {
    async create(request) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const parsed = await readJsonBody(request, createHabitRequestSchema);
      if (!parsed.ok) return parsed.response;
      const body = parsed.data;

      return run(async () => {
        const record = await deps.useCases.create({
          actorUserId,
          kind: body.kind,
          name: body.name,
          purpose: body.purpose,
          cue: body.cue,
          minimumAction: body.minimumAction,
          ...(body.replacementAction !== undefined
            ? { replacementAction: body.replacementAction }
            : {}),
          schedule: body.schedule,
        });
        return jsonResponse(201, toHabitResponse(record), {
          Location: `/api/v1/habits/${record.habit.id}`,
        });
      });
    },

    async list(request) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const query = listHabitsQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return validationFailedResponse(toFieldErrors(query.error.issues));

      return run(async () => {
        const result = await deps.useCases.list({
          actorUserId,
          status: query.data.status,
          limit: query.data.limit,
          cursor: query.data.cursor,
        });
        const body: HabitListResponse = {
          items: result.items.map(toHabitResponse),
          nextCursor: result.nextCursor,
        };
        return jsonResponse(200, body);
      });
    },

    async get(request, params) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();
      if (!UUID_PATTERN.test(params.habitId)) return habitNotFoundResponse();

      return run(async () => {
        const record = await deps.useCases.get({ actorUserId, habitId: params.habitId });
        return jsonResponse(200, toHabitResponse(record));
      });
    },

    async update(request, params) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();
      if (!UUID_PATTERN.test(params.habitId)) return habitNotFoundResponse();

      const parsed = await readJsonBody(request, updateHabitRequestSchema);
      if (!parsed.ok) return parsed.response;
      const body = parsed.data;

      const details: UpdateHabitDetailsInput = {};
      if (body.name !== undefined) details.name = body.name;
      if (body.purpose !== undefined) details.purpose = body.purpose;
      if (body.cue !== undefined) details.cue = body.cue;
      if (body.minimumAction !== undefined) details.minimumAction = body.minimumAction;
      if (body.replacementAction !== undefined) details.replacementAction = body.replacementAction;

      return run(async () => {
        const record = await deps.useCases.update({
          actorUserId,
          habitId: params.habitId,
          version: body.version,
          details: Object.keys(details).length > 0 ? details : undefined,
          schedule: body.schedule,
        });
        return jsonResponse(200, toHabitResponse(record));
      });
    },

    async archive(request, params) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();
      if (!UUID_PATTERN.test(params.habitId)) return habitNotFoundResponse();

      const parsed = await readJsonBody(request, archiveHabitRequestSchema);
      if (!parsed.ok) return parsed.response;

      return run(async () => {
        const record = await deps.useCases.archive({
          actorUserId,
          habitId: params.habitId,
          version: parsed.data.version,
        });
        return jsonResponse(200, toHabitResponse(record));
      });
    },
  };
}
