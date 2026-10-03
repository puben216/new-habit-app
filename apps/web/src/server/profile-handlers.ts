import {
  createProblemDetails,
  toFieldErrors,
  UPDATE_PROFILE_MAX_BODY_BYTES,
  updateProfileRequestSchema,
  type ProblemDetails,
  type ProfileResponse,
} from "@habit-app/contracts";

import { ProfileNotFoundError, type Actor, type ProfileView } from "@habit-app/application";
import { InvalidProfileError, type ProfileChangesInput } from "@habit-app/domain";

/**
 * `GET/PATCH /api/v1/me` の Presentation 層(docs/specs/user-profile.md)。
 * HTTP と Application DTO の変換のみを担い、業務ロジックは持たない。
 * 依存(session 解決、use case)を注入できる factory とし、Next.js なしで単体テストできるようにする。
 *
 * ログ方針: 表示名・body・cookie を出さない。想定外の例外は error 名のみを構造化 log に出す。
 */

export interface ProfileHandlerDeps {
  /** session から actor user ID を取得する。未認証・期限切れ・失効なら null(AUTH-009)。 */
  readonly getActorUserId: () => Promise<string | null>;
  readonly getMyProfile: (actor: Actor) => Promise<ProfileView>;
  readonly updateMyProfile: (actor: Actor, input: ProfileChangesInput) => Promise<ProfileView>;
  /** 許可する Origin(`APP_BASE_URL` の origin)。CSRF 対策(Spec Security 節)。 */
  readonly allowedOrigin: string;
  /** 構造化 log の出力先。既定は console.error。 */
  readonly logError?: (entry: Readonly<Record<string, string>>) => void;
}

export interface ProfileHandlers {
  readonly GET: (request: Request) => Promise<Response>;
  readonly PATCH: (request: Request) => Promise<Response>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function problem(
  status: number,
  code: string,
  message: string,
  fieldErrors?: Readonly<Record<string, readonly string[]>>,
): Response {
  const body: ProblemDetails = createProblemDetails({
    code,
    message,
    ...(fieldErrors === undefined ? {} : { fieldErrors }),
  });
  return Response.json(body, { status, headers: NO_STORE });
}

function unauthenticated(): Response {
  return problem(401, "unauthenticated", "authentication is required");
}

function notFound(): Response {
  return problem(404, "not_found", "resource not found");
}

function toProfileResponse(view: ProfileView): ProfileResponse {
  return {
    displayName: view.displayName,
    timezone: view.timezone,
    locale: view.locale,
    weekStartsOn: view.weekStartsOn,
    updatedAt: view.updatedAt.toISOString(),
  };
}

function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType !== null && /^application\/json\s*(;|$)/i.test(contentType.trim());
}

/** body を上限付きで読む。上限超過なら null(JSON parse 前に拒否する)。 */
async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;

  const text = await request.text();
  return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
}

export function createProfileHandlers(deps: ProfileHandlerDeps): ProfileHandlers {
  const logError =
    deps.logError ??
    ((entry: Readonly<Record<string, string>>): void => {
      console.error(JSON.stringify(entry));
    });

  function internalError(error: unknown): Response {
    const response = problem(500, "internal_error", "internal server error");
    logError({
      level: "error",
      route: "/api/v1/me",
      errorCode: "internal_error",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return response;
  }

  return {
    async GET() {
      try {
        const userId = await deps.getActorUserId();
        if (userId === null) return unauthenticated();

        const view = await deps.getMyProfile({ userId });
        return Response.json(toProfileResponse(view), { status: 200, headers: NO_STORE });
      } catch (error) {
        if (error instanceof ProfileNotFoundError) return notFound();
        return internalError(error);
      }
    },

    async PATCH(request) {
      try {
        const userId = await deps.getActorUserId();
        if (userId === null) return unauthenticated();

        // CSRF: ブラウザが付ける Origin が許可 Origin と異なれば拒否する(欠如は非ブラウザ client として許可)。
        const origin = request.headers.get("origin");
        if (origin !== null && origin !== deps.allowedOrigin) {
          return problem(403, "forbidden_origin", "request origin is not allowed");
        }

        if (!isJsonContentType(request)) {
          return problem(415, "unsupported_media_type", "content type must be application/json");
        }

        const text = await readLimitedText(request, UPDATE_PROFILE_MAX_BODY_BYTES);
        if (text === null) {
          return problem(413, "payload_too_large", "request body is too large");
        }

        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return problem(
            422,
            "invalid_request_body",
            "リクエストボディを JSON として解釈できません",
          );
        }

        const parsed = updateProfileRequestSchema.safeParse(json);
        if (!parsed.success) {
          return problem(
            422,
            "validation_failed",
            "入力値が不正です",
            toFieldErrors(parsed.error.issues),
          );
        }

        const view = await deps.updateMyProfile({ userId }, parsed.data);
        return Response.json(toProfileResponse(view), { status: 200, headers: NO_STORE });
      } catch (error) {
        if (error instanceof ProfileNotFoundError) return notFound();
        if (error instanceof InvalidProfileError) {
          const fieldErrors: Record<string, string[]> = {};
          for (const violation of error.violations) {
            (fieldErrors[violation.field] ??= []).push(violation.message);
          }
          return problem(422, "validation_failed", "入力値が不正です", fieldErrors);
        }
        return internalError(error);
      }
    },
  };
}
