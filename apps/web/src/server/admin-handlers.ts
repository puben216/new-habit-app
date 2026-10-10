import type {
  AdminAccess,
  AdminRequestContext,
  AiJobFailureView,
  ListInput,
  Page,
  UserOverview,
  UserSearchItem,
  VerifyAdminMfaResult,
} from "@habit-app/application";
import type { NotificationFailureItem } from "@habit-app/application";
import {
  ADMIN_REQUEST_BODY_MAX_BYTES,
  adminAiJobFailuresQuerySchema,
  adminMfaVerifyRequestSchema,
  adminNotificationFailuresQuerySchema,
  adminUserPublicIdSchema,
  adminUserSearchQuerySchema,
  toFieldErrors,
} from "@habit-app/contracts";
import type {
  AdminAiJobFailuresResponse,
  AdminMeResponse,
  AdminNotificationFailuresResponse,
  AdminUserOverviewResponse,
  AdminUserSearchResponse,
} from "@habit-app/contracts";

import {
  invalidOriginResponse,
  isTrustedOrigin,
  jsonResponse,
  problemResponse,
  readJsonBody,
  unauthorizedResponse,
  validationFailedResponse,
} from "./habit-http";
import type { AdminSessionInfo } from "./session-actor";

/**
 * `/api/v1/admin/*` の route handler 本体(docs/specs/minimal-admin.md)。
 * route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、session 解決・認可の振り分け・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 *
 * 振り分け(ADM-002 / ADM-INV-002): 未認証 → 401、管理者でない → 404(管理 route の存在を明かさない。
 * 本文・ヘッダーはどの route でも同一)、管理者だが MFA 未検証/期限切れ → 403(mfa_required)。
 * 認可を通る前に Origin・Content-Type・body・query の検証結果(422 など)を返さない。
 */

type AdminIdentityOf<T extends AdminAccess> = Extract<T, { admin: unknown }>["admin"];
type GrantedAccess = Extract<AdminAccess, { status: "granted" }>;
type AdminIdentity = AdminIdentityOf<AdminAccess>;

export interface AdminUseCases {
  verifyMfa(input: {
    actorUserId: string;
    sessionId: string;
    code: unknown;
    context: AdminRequestContext;
  }): Promise<VerifyAdminMfaResult>;
  searchUser(input: {
    admin: AdminIdentity;
    context: AdminRequestContext;
    email: string;
  }): Promise<readonly UserSearchItem[]>;
  getUserOverview(input: {
    admin: AdminIdentity;
    context: AdminRequestContext;
    publicId: string;
  }): Promise<UserOverview | null>;
  listNotificationFailures(
    input: ListInput<"failed" | "expired" | "suppressed">,
  ): Promise<Page<NotificationFailureItem>>;
  listAiJobFailures(input: ListInput<"failed" | "fallback">): Promise<Page<AiJobFailureView>>;
}

export interface AdminHandlerDeps {
  /** session から actor・session 行・MFA 検証時刻を取得する。未認証は null。 */
  readonly resolveSession: (request: Request) => Promise<AdminSessionInfo | null>;
  /** 管理者の認可(毎回 DB で判定)。 */
  readonly authorize: (input: {
    actorUserId: string;
    mfaVerifiedAt: Date | null;
  }) => Promise<AdminAccess>;
  readonly allowedOrigin: string;
  /** IP の不可逆化(HMAC)。生の IP を Application に渡さない。 */
  readonly hashIp: (ip: string | null) => string;
  readonly newRequestId: () => string;
  readonly now: () => Date;
  readonly useCases: AdminUseCases;
}

export interface AdminHandlers {
  verifyMfa(request: Request): Promise<Response>;
  me(request: Request): Promise<Response>;
  searchUsers(request: Request): Promise<Response>;
  getUser(request: Request, params: { readonly publicId: string }): Promise<Response>;
  listNotificationFailures(request: Request): Promise<Response>;
  listAiJobFailures(request: Request): Promise<Response>;
  /** `/api/v1/admin/` 配下の未定義 path。未認証 401、それ以外は 404(存在する route と同じ応答)。 */
  notFound(request: Request): Promise<Response>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function notFoundResponse(): Response {
  return withAdminHeaders(problemResponse(404, { code: "not_found", message: "見つかりません" }));
}

/** 管理 API の応答に付ける共通ヘッダー(検索エンジンに載せない)。 */
function withAdminHeaders(response: Response): Response {
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return withAdminHeaders(jsonResponse(status, body, headers));
}

/**
 * ALB 背後では、ALB が client の IP を `X-Forwarded-For` の末尾に追加する。client が先頭側を
 * 偽装できるため、末尾(自分たちの proxy が付けた値)を使う。信頼する proxy 段数は共通基盤(T-501)で確定する。
 * 監査ログには不可逆化した値だけを残す。
 */
function clientIpFrom(request: Request): string | null {
  const header = request.headers.get("x-forwarded-for");
  if (header === null) return null;
  const last = header.split(",").pop()?.trim() ?? "";
  return last.length > 0 && last.length <= 45 ? last : null;
}

type Guard =
  | { readonly ok: false; readonly response: Response }
  | {
      readonly ok: true;
      readonly session: AdminSessionInfo;
      readonly access: Exclude<AdminAccess, { status: "not_admin" }>;
      readonly context: AdminRequestContext;
    };

export function createAdminHandlers(deps: AdminHandlerDeps): AdminHandlers {
  async function guard(request: Request): Promise<Guard> {
    const session = await deps.resolveSession(request);
    if (session === null) return { ok: false, response: withAdminHeaders(unauthorizedResponse()) };

    const access = await deps.authorize({
      actorUserId: session.userId,
      mfaVerifiedAt: session.mfaVerifiedAt,
    });
    if (access.status === "not_admin") return { ok: false, response: notFoundResponse() };

    const header = request.headers.get("x-request-id");
    const requestId =
      header !== null && REQUEST_ID_PATTERN.test(header) ? header : deps.newRequestId();
    return {
      ok: true,
      session,
      access,
      context: { requestId, ipHash: deps.hashIp(clientIpFrom(request)) },
    };
  }

  /** 閲覧 API 用。MFA が有効な管理者だけを通す。 */
  async function guardGranted(
    request: Request,
  ): Promise<
    | { readonly ok: false; readonly response: Response }
    | { readonly ok: true; readonly access: GrantedAccess; readonly context: AdminRequestContext }
  > {
    const g = await guard(request);
    if (!g.ok) return g;
    if (g.access.status !== "granted") {
      return {
        ok: false,
        response: withAdminHeaders(
          problemResponse(403, {
            code: "mfa_required",
            message: "多要素認証が必要です",
          }),
        ),
      };
    }
    return { ok: true, access: g.access, context: g.context };
  }

  function queryObject(request: Request): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) result[key] = value;
    return result;
  }

  return {
    async verifyMfa(request) {
      const g = await guard(request);
      if (!g.ok) return g.response;
      // 認可の後に Origin・body を検証する(管理 route の存在・形式を Member に明かさない)。
      if (!isTrustedOrigin(request, deps.allowedOrigin)) {
        return withAdminHeaders(invalidOriginResponse());
      }
      const parsed = await readJsonBody(
        request,
        adminMfaVerifyRequestSchema,
        ADMIN_REQUEST_BODY_MAX_BYTES,
      );
      if (!parsed.ok) return withAdminHeaders(parsed.response);

      const result = await deps.useCases.verifyMfa({
        actorUserId: g.session.userId,
        sessionId: g.session.sessionId,
        code: parsed.data.code,
        context: g.context,
      });
      switch (result.status) {
        case "verified":
          return json(200, { status: "verified" });
        case "not_admin":
          return notFoundResponse();
        case "locked":
          return withAdminHeaders(
            jsonResponse(
              429,
              {
                code: "mfa_locked",
                message: "試行回数が上限に達しました。しばらくしてからやり直してください",
              },
              { "Retry-After": String(result.retryAfterSeconds) },
            ),
          );
        case "invalid":
          return withAdminHeaders(
            problemResponse(403, { code: "invalid_mfa_code", message: "コードが正しくありません" }),
          );
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    },

    async me(request) {
      const g = await guard(request);
      if (!g.ok) return g.response;
      // MFA が有効でない(未検証または期限切れ)管理者には有効期限がない。
      const expiresAt = g.access.status === "granted" ? g.access.mfaExpiresAt : null;
      const body: AdminMeResponse = {
        adminPublicId: g.access.admin.adminPublicId,
        mfaVerified: g.access.status === "granted",
        mfaExpiresAt: expiresAt === null ? null : expiresAt.toISOString(),
      };
      return json(200, body);
    },

    async searchUsers(request) {
      const g = await guardGranted(request);
      if (!g.ok) return g.response;
      const query = adminUserSearchQuerySchema.safeParse(queryObject(request));
      if (!query.success) {
        return withAdminHeaders(validationFailedResponse(toFieldErrors(query.error.issues)));
      }
      const items = await deps.useCases.searchUser({
        admin: g.access.admin,
        context: g.context,
        email: query.data.email,
      });
      const body: AdminUserSearchResponse = {
        items: items.map((item) => ({
          publicId: item.publicId,
          emailMasked: item.emailMasked,
          status: item.status,
          createdAt: item.createdAt.toISOString(),
        })),
      };
      return json(200, body);
    },

    async getUser(request, params) {
      const g = await guardGranted(request);
      if (!g.ok) return g.response;
      const publicId = adminUserPublicIdSchema.safeParse(params.publicId);
      if (!publicId.success) {
        return withAdminHeaders(
          validationFailedResponse({ publicId: ["公開 ID は UUID で指定してください"] }),
        );
      }
      const overview = await deps.useCases.getUserOverview({
        admin: g.access.admin,
        context: g.context,
        publicId: publicId.data,
      });
      if (overview === null) {
        return withAdminHeaders(
          problemResponse(404, { code: "user_not_found", message: "ユーザーが見つかりません" }),
        );
      }
      const body: AdminUserOverviewResponse = {
        publicId: overview.publicId,
        emailMasked: overview.emailMasked,
        status: overview.status,
        createdAt: overview.createdAt.toISOString(),
        emailVerified: overview.emailVerified,
        notification: {
          suppressed: overview.notification.suppressed,
          deliveries: { ...overview.notification.deliveries },
        },
        aiJobs: { ...overview.aiJobs },
      };
      return json(200, body);
    },

    async listNotificationFailures(request) {
      const g = await guardGranted(request);
      if (!g.ok) return g.response;
      const query = adminNotificationFailuresQuerySchema.safeParse(queryObject(request));
      if (!query.success) {
        return withAdminHeaders(validationFailedResponse(toFieldErrors(query.error.issues)));
      }
      const page = await deps.useCases.listNotificationFailures({
        admin: g.access.admin,
        context: g.context,
        statuses: query.data.status === undefined ? undefined : [query.data.status],
        limit: query.data.limit,
        cursor: query.data.cursor ?? null,
      });
      const body: AdminNotificationFailuresResponse = {
        items: page.items.map((item) => ({
          id: item.id,
          userPublicId: item.userPublicId,
          status: item.status as AdminNotificationFailuresResponse["items"][number]["status"],
          failureCode: item.failureCode,
          attemptCount: item.attemptCount,
          scheduledAt: item.scheduledAt.toISOString(),
          localDate: item.localDate,
          updatedAt: item.updatedAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
      return json(200, body);
    },

    async listAiJobFailures(request) {
      const g = await guardGranted(request);
      if (!g.ok) return g.response;
      const query = adminAiJobFailuresQuerySchema.safeParse(queryObject(request));
      if (!query.success) {
        return withAdminHeaders(validationFailedResponse(toFieldErrors(query.error.issues)));
      }
      const page = await deps.useCases.listAiJobFailures({
        admin: g.access.admin,
        context: g.context,
        statuses: query.data.status === undefined ? undefined : [query.data.status],
        limit: query.data.limit,
        cursor: query.data.cursor ?? null,
      });
      const body: AdminAiJobFailuresResponse = {
        items: page.items.map((item) => ({
          publicId: item.publicId,
          userPublicId: item.userPublicId,
          kind: item.kind,
          status: item.status as AdminAiJobFailuresResponse["items"][number]["status"],
          failureCode: item.failureCode,
          provider: item.provider,
          model: item.model,
          promptVersion: item.promptVersion,
          createdAt: item.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
      return json(200, body);
    },

    async notFound(request) {
      const session = await deps.resolveSession(request);
      return session === null ? withAdminHeaders(unauthorizedResponse()) : notFoundResponse();
    },
  };
}
