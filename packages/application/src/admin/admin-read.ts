import {
  ADMIN_OVERVIEW_WINDOW_DAYS,
  ADMIN_PAGE_SIZE_DEFAULT,
  ADMIN_PAGE_SIZE_MAX,
  adminAuditActor,
  maskEmail,
  normalizeEmail,
} from "@habit-app/domain";
import type { AdminAuditAction } from "@habit-app/domain";

import type { Clock } from "../auth";
import type {
  AdminIdentity,
  AdminReadPort,
  AdminRequestContext,
  AiJobFailureItem,
  AiJobFailureStatus,
  AuditLogPort,
  NotificationFailureItem,
  NotificationFailureStatus,
} from "./ports";

/**
 * 管理者の閲覧 use case(ADM-004〜007)。すべて、閲覧の **前** に監査ログを追記し、追記に失敗したら
 * 閲覧を行わず失敗させる(ADM-INV-004、fail closed)。監査には actor、action、対象の公開 ID、
 * request ID、IP のハッシュだけを残し、検索に使った email などの入力は残さない。
 * 認可(有効な管理者 + MFA)は呼び出し側が `authorizeAdmin` で済ませてから呼ぶ。
 */

export interface AdminReadDeps {
  readonly read: AdminReadPort;
  readonly audit: AuditLogPort;
  readonly now: Clock;
}

interface AuditedInput {
  readonly admin: AdminIdentity;
  readonly context: AdminRequestContext;
}

const MS_PER_DAY = 86_400_000;

async function audited<T>(
  deps: AdminReadDeps,
  input: AuditedInput,
  entry: { action: AdminAuditAction; targetType: string; targetPublicId: string | null },
  now: Date,
  read: () => Promise<T>,
): Promise<T> {
  await deps.audit.append({
    actor: adminAuditActor(input.admin.adminPublicId),
    action: entry.action,
    targetType: entry.targetType,
    targetPublicId: entry.targetPublicId,
    requestId: input.context.requestId,
    ipHash: input.context.ipHash,
    now,
  });
  return read();
}

export interface UserSearchItem {
  readonly publicId: string;
  readonly emailMasked: string;
  readonly status: string;
  readonly createdAt: Date;
}

/** email の完全一致(正規化後)で 0〜1 件。部分一致・列挙はできない。 */
export async function searchUserByEmailUseCase(
  deps: AdminReadDeps,
  input: AuditedInput & { readonly email: string },
): Promise<readonly UserSearchItem[]> {
  const now = deps.now();
  return audited(
    deps,
    input,
    { action: "admin.user.search", targetType: "user", targetPublicId: null },
    now,
    async () => {
      const user = await deps.read.findUserByEmail(normalizeEmail(input.email));
      return user === null
        ? []
        : [
            {
              publicId: user.publicId,
              emailMasked: maskEmail(user.email),
              status: user.status,
              createdAt: user.createdAt,
            },
          ];
    },
  );
}

export interface UserOverview {
  readonly publicId: string;
  readonly emailMasked: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly emailVerified: boolean;
  readonly notification: {
    readonly suppressed: boolean;
    readonly deliveries: Readonly<Record<string, number>>;
  };
  readonly aiJobs: Readonly<Record<string, number>>;
}

/** ユーザーの概要(状態・直近 30 日の件数)。存在しなければ `null`(呼び出し側は 404)。 */
export async function getUserOverviewUseCase(
  deps: AdminReadDeps,
  input: AuditedInput & { readonly publicId: string },
): Promise<UserOverview | null> {
  const now = deps.now();
  return audited(
    deps,
    input,
    { action: "admin.user.view", targetType: "user", targetPublicId: input.publicId },
    now,
    async () => {
      const since = new Date(now.getTime() - ADMIN_OVERVIEW_WINDOW_DAYS * MS_PER_DAY);
      const record = await deps.read.getUserOverview({ publicId: input.publicId, since });
      if (record === null) return null;
      return {
        publicId: record.publicId,
        emailMasked: maskEmail(record.email),
        status: record.status,
        createdAt: record.createdAt,
        emailVerified: record.emailVerified,
        notification: { suppressed: record.suppressed, deliveries: record.notificationDeliveries },
        aiJobs: record.aiJobs,
      };
    },
  );
}

const DEFAULT_NOTIFICATION_STATUSES: readonly NotificationFailureStatus[] = [
  "failed",
  "expired",
  "suppressed",
];
const DEFAULT_AI_JOB_STATUSES: readonly AiJobFailureStatus[] = ["failed", "fallback"];

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return ADMIN_PAGE_SIZE_DEFAULT;
  return Math.min(Math.max(Math.trunc(limit), 1), ADMIN_PAGE_SIZE_MAX);
}

export interface ListInput<S> extends AuditedInput {
  readonly statuses?: readonly S[] | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | null | undefined;
}

/** 通知配送の失敗(failed/expired/suppressed)を新しい順に。email・設定の中身は含まない。 */
export async function listNotificationFailuresUseCase(
  deps: AdminReadDeps,
  input: ListInput<NotificationFailureStatus>,
): Promise<Page<NotificationFailureItem>> {
  const limit = clampLimit(input.limit);
  const now = deps.now();
  return audited(
    deps,
    input,
    {
      action: "admin.notifications.list",
      targetType: "notification_delivery",
      targetPublicId: null,
    },
    now,
    async () => {
      // 次ページの有無を判定するため 1 件多く取る。
      const rows = await deps.read.listNotificationFailures({
        statuses: input.statuses?.length ? input.statuses : DEFAULT_NOTIFICATION_STATUSES,
        limit: limit + 1,
        afterId: input.cursor ?? null,
      });
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > limit && last !== undefined ? last.id : null };
    },
  );
}

export type AiJobFailureView = Omit<AiJobFailureItem, "cursorId">;

/** AI ジョブの失敗(failed/fallback)を新しい順に。入出力・結果本文は含まない。 */
export async function listAiJobFailuresUseCase(
  deps: AdminReadDeps,
  input: ListInput<AiJobFailureStatus>,
): Promise<Page<AiJobFailureView>> {
  const limit = clampLimit(input.limit);
  const now = deps.now();
  return audited(
    deps,
    input,
    { action: "admin.ai_jobs.list", targetType: "ai_job", targetPublicId: null },
    now,
    async () => {
      const rows = await deps.read.listAiJobFailures({
        statuses: input.statuses?.length ? input.statuses : DEFAULT_AI_JOB_STATUSES,
        limit: limit + 1,
        afterId: input.cursor ?? null,
      });
      const pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      // 内部の cursor ID は応答に含めない(項目を明示的に選ぶ)。
      const items = pageRows.map(
        ({
          publicId,
          userPublicId,
          kind,
          status,
          failureCode,
          provider,
          model,
          promptVersion,
          createdAt,
        }) => ({
          publicId,
          userPublicId,
          kind,
          status,
          failureCode,
          provider,
          model,
          promptVersion,
          createdAt,
        }),
      );
      return {
        items,
        nextCursor: rows.length > limit && last !== undefined ? last.cursorId : null,
      };
    },
  );
}
