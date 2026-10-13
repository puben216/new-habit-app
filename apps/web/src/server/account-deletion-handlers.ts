import {
  AccountNotActiveError,
  AccountNotFoundError,
  DeletionAlreadyRequestedError,
  DeletionNotRequestedError,
  GracePeriodExpiredError,
  ReauthenticationFailedError,
  TooManyAttemptsError,
} from "@habit-app/application";
import type {
  AccountDeletionRequested,
  AccountDeletionStatus,
  AccountRequestContext,
} from "@habit-app/application";
import {
  ACCOUNT_DELETION_REQUEST_MAX_BODY_BYTES,
  requestAccountDeletionRequestSchema,
} from "@habit-app/contracts";
import type {
  AccountDeletionCancelledResponse,
  AccountDeletionRequestedResponse,
  AccountDeletionStatusResponse,
} from "@habit-app/contracts";

import { clientIpFrom } from "./client-ip";
import {
  invalidOriginResponse,
  isTrustedOrigin,
  jsonResponse,
  problemResponse,
  readJsonBody,
  unauthorizedResponse,
} from "./habit-http";
import type { AccountSessionInfo } from "./session-actor";

/**
 * `DELETE /api/v1/me`、`GET /api/v1/me/deletion`、`POST /api/v1/me/deletion/cancel` の handler 本体
 * (docs/specs/account-deletion.md)。route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 *
 * 削除の要求は Member 向け API なので、削除予約中の session は actor を持たず 401 になる(ACD-INV-003)。
 * 状態の確認と取り消しだけが、削除予約中の session でも使える。
 */

export interface AccountDeletionUseCases {
  request(input: {
    actorUserId: string;
    password: string;
    context: AccountRequestContext;
  }): Promise<AccountDeletionRequested>;
  cancel(input: {
    actorUserId: string;
    context: AccountRequestContext;
  }): Promise<{ readonly status: "active" }>;
  status(input: { actorUserId: string }): Promise<AccountDeletionStatus>;
}

export interface AccountDeletionHandlerDeps {
  /** Member 向けの actor(削除予約中の session は null)。 */
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  /** 削除予約中の session でも取り出せるアカウント情報(状態の確認・取り消し用)。 */
  readonly resolveAccountSession: (request: Request) => Promise<AccountSessionInfo | null>;
  readonly allowedOrigin: string;
  /** IP の不可逆化。生の IP を Application に渡さない。 */
  readonly hashIp: (ip: string | null) => string;
  readonly newRequestId: () => string;
  readonly useCases: AccountDeletionUseCases;
}

export interface AccountDeletionHandlers {
  request(request: Request): Promise<Response>;
  status(request: Request): Promise<Response>;
  cancel(request: Request): Promise<Response>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** use case が投げたエラーを HTTP 応答へ変換する。未知のエラーは null を返し、呼び出し側が再 throw する。 */
function mapAccountError(error: unknown): Response | null {
  if (error instanceof ReauthenticationFailedError) {
    return problemResponse(403, {
      code: "reauthentication_failed",
      message: "パスワードを確認できませんでした",
    });
  }
  if (error instanceof TooManyAttemptsError) {
    return problemResponse(429, {
      code: "too_many_attempts",
      message: "試行回数が上限に達しました。しばらくしてからやり直してください",
    });
  }
  if (error instanceof DeletionAlreadyRequestedError) {
    return problemResponse(409, {
      code: "deletion_already_requested",
      message: "既に削除が予約されています",
    });
  }
  if (error instanceof AccountNotActiveError) {
    return problemResponse(409, {
      code: "account_not_active",
      message: "このアカウントでは削除を要求できません",
    });
  }
  if (error instanceof DeletionNotRequestedError) {
    return problemResponse(409, {
      code: "deletion_not_requested",
      message: "削除は予約されていません",
    });
  }
  if (error instanceof GracePeriodExpiredError) {
    return problemResponse(409, {
      code: "grace_period_expired",
      message: "猶予期間を過ぎているため取り消せません",
    });
  }
  if (error instanceof AccountNotFoundError) {
    return problemResponse(404, { code: "user_not_found", message: "ユーザーが見つかりません" });
  }
  return null;
}

export function createAccountDeletionHandlers(
  deps: AccountDeletionHandlerDeps,
): AccountDeletionHandlers {
  function contextOf(request: Request): AccountRequestContext {
    const header = request.headers.get("x-request-id");
    return {
      requestId: header !== null && REQUEST_ID_PATTERN.test(header) ? header : deps.newRequestId(),
      ipHash: deps.hashIp(clientIpFrom(request)),
    };
  }

  async function run(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      const response = mapAccountError(error);
      if (response === null) throw error;
      return response;
    }
  }

  return {
    async request(request) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const parsed = await readJsonBody(
        request,
        requestAccountDeletionRequestSchema,
        ACCOUNT_DELETION_REQUEST_MAX_BODY_BYTES,
      );
      if (!parsed.ok) return parsed.response;

      return run(async () => {
        const result = await deps.useCases.request({
          actorUserId,
          password: parsed.data.password,
          context: contextOf(request),
        });
        const body: AccountDeletionRequestedResponse = {
          status: "deletion_pending",
          scheduledFor: result.scheduledFor.toISOString(),
        };
        return jsonResponse(200, body);
      });
    },

    async status(request) {
      const account = await deps.resolveAccountSession(request);
      if (account === null) return unauthorizedResponse();

      return run(async () => {
        const result = await deps.useCases.status({ actorUserId: account.userId });
        const body: AccountDeletionStatusResponse = {
          status: result.status,
          scheduledFor: result.scheduledFor === null ? null : result.scheduledFor.toISOString(),
        };
        return jsonResponse(200, body);
      });
    },

    async cancel(request) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const account = await deps.resolveAccountSession(request);
      if (account === null) return unauthorizedResponse();

      return run(async () => {
        await deps.useCases.cancel({ actorUserId: account.userId, context: contextOf(request) });
        const body: AccountDeletionCancelledResponse = { status: "active" };
        return jsonResponse(200, body);
      });
    },
  };
}
