import {
  AccountNotActiveError,
  AccountNotFoundError,
  ExportExpiredError,
  ExportInProgressError,
  ExportNotFoundError,
  ExportNotReadyError,
  ExportRateLimitedError,
  ExportUnavailableError,
  ReauthenticationFailedError,
  TooManyAttemptsError,
} from "@habit-app/application";
import type {
  AccountRequestContext,
  DataExportDownload,
  DataExportRecord,
} from "@habit-app/application";
import {
  DATA_EXPORT_REQUEST_MAX_BODY_BYTES,
  createDataExportRequestSchema,
} from "@habit-app/contracts";
import type { DataExportListResponse, DataExportResponse } from "@habit-app/contracts";
import type { DataExportFormat } from "@habit-app/domain";

import { clientIpFrom } from "./client-ip";
import {
  invalidOriginResponse,
  isTrustedOrigin,
  jsonResponse,
  problemResponse,
  readJsonBody,
  unauthorizedResponse,
} from "./habit-http";

/**
 * `/api/v1/me/exports*` の route handler 本体(docs/specs/data-export.md)。
 * route.ts はこの関数群へ委譲するだけの薄い adapter にする(ADR-009)。
 * 業務ロジックは持たず、actor 解決・入力検証・use case 呼び出し・HTTP 変換のみを行う。
 *
 * 削除予約中の session は Member 向け API の actor を持たず 401 になる(アカウント削除の ACD-INV-003)。
 */

export interface DataExportUseCases {
  request(input: {
    actorUserId: string;
    password: string;
    format: DataExportFormat;
    context: AccountRequestContext;
  }): Promise<DataExportRecord>;
  list(input: { actorUserId: string }): Promise<readonly DataExportRecord[]>;
  download(input: {
    actorUserId: string;
    exportId: string;
    context: AccountRequestContext;
  }): Promise<DataExportDownload>;
}

export interface DataExportHandlerDeps {
  readonly resolveActorUserId: (request: Request) => Promise<string | null>;
  readonly allowedOrigin: string;
  /** IP の不可逆化。生の IP を Application に渡さない。 */
  readonly hashIp: (ip: string | null) => string;
  readonly newRequestId: () => string;
  readonly useCases: DataExportUseCases;
}

export interface DataExportHandlers {
  create(request: Request): Promise<Response>;
  list(request: Request): Promise<Response>;
  download(request: Request, params: { readonly exportId: string }): Promise<Response>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** use case が投げたエラーを HTTP 応答へ変換する。未知のエラーは null を返し、呼び出し側が再 throw する。 */
function mapExportError(error: unknown): Response | null {
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
  if (error instanceof ExportInProgressError) {
    return problemResponse(409, {
      code: "export_in_progress",
      message: "作成中のエクスポートがあります",
    });
  }
  if (error instanceof ExportRateLimitedError) {
    return problemResponse(429, {
      code: "export_rate_limited",
      message: "エクスポートを作成できる回数の上限に達しました",
    });
  }
  if (error instanceof ExportNotFoundError) {
    return problemResponse(404, {
      code: "export_not_found",
      message: "エクスポートが見つかりません",
    });
  }
  if (error instanceof ExportNotReadyError) {
    return problemResponse(409, {
      code: "export_not_ready",
      message: "エクスポートはまだ完成していません",
    });
  }
  if (error instanceof ExportExpiredError) {
    return problemResponse(410, {
      code: "export_expired",
      message: "エクスポートの期限が切れています",
    });
  }
  if (error instanceof ExportUnavailableError) {
    return problemResponse(503, {
      code: "export_unavailable",
      message: "エクスポートを開始できませんでした。時間をおいてやり直してください",
    });
  }
  if (error instanceof AccountNotActiveError) {
    return problemResponse(409, {
      code: "account_not_active",
      message: "このアカウントではエクスポートを作成できません",
    });
  }
  if (error instanceof AccountNotFoundError) {
    return problemResponse(404, { code: "user_not_found", message: "ユーザーが見つかりません" });
  }
  return null;
}

function toResponse(record: DataExportRecord): DataExportResponse {
  return {
    id: record.id,
    status: record.status,
    format: record.format,
    requestedAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
    byteSize: record.byteSize,
    failureCode: record.failureCode,
  };
}

export function createDataExportHandlers(deps: DataExportHandlerDeps): DataExportHandlers {
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
      const response = mapExportError(error);
      if (response === null) throw error;
      return response;
    }
  }

  return {
    async create(request) {
      if (!isTrustedOrigin(request, deps.allowedOrigin)) return invalidOriginResponse();
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      const parsed = await readJsonBody(
        request,
        createDataExportRequestSchema,
        DATA_EXPORT_REQUEST_MAX_BODY_BYTES,
      );
      if (!parsed.ok) return parsed.response;

      return run(async () => {
        const record = await deps.useCases.request({
          actorUserId,
          password: parsed.data.password,
          format: parsed.data.format,
          context: contextOf(request),
        });
        return jsonResponse(202, toResponse(record));
      });
    },

    async list(request) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      return run(async () => {
        const records = await deps.useCases.list({ actorUserId });
        const body: DataExportListResponse = { items: records.map(toResponse) };
        return jsonResponse(200, body);
      });
    },

    async download(request, params) {
      const actorUserId = await deps.resolveActorUserId(request);
      if (actorUserId === null) return unauthorizedResponse();

      return run(async () => {
        const file = await deps.useCases.download({
          actorUserId,
          exportId: params.exportId,
          context: contextOf(request),
        });
        // ファイル名・Content-Type は完成時にサーバーが決めた固定の値(ユーザー入力を含まない)。
        return new Response(new Blob([new Uint8Array(file.content)], { type: file.contentType }), {
          status: 200,
          headers: {
            "Content-Type": file.contentType,
            "Content-Disposition": `attachment; filename="${file.fileName}"`,
            "Content-Length": String(file.content.length),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      });
    },
  };
}
