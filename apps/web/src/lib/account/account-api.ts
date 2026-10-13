import {
  accountDeletionCancelledResponseSchema,
  accountDeletionRequestedResponseSchema,
  accountDeletionStatusResponseSchema,
  type AccountDeletionCancelledResponse,
  type AccountDeletionRequestedResponse,
  type AccountDeletionStatusResponse,
} from "@habit-app/contracts";

import { apiRequest } from "@/lib/api/client";

/**
 * アカウント削除の型付き client(docs/specs/account-deletion.md)。パスワードは body にだけ載せ、
 * queryKey・URL・storage には載せない。
 */

export const accountDeletionStatusQueryKey = ["account", "deletion"] as const;

export function requestAccountDeletion(
  password: string,
): Promise<AccountDeletionRequestedResponse> {
  return apiRequest({
    method: "DELETE",
    path: "/api/v1/me",
    schema: accountDeletionRequestedResponseSchema,
    body: { password },
  });
}

export function getAccountDeletionStatus(
  signal?: AbortSignal,
): Promise<AccountDeletionStatusResponse> {
  return apiRequest({
    path: "/api/v1/me/deletion",
    schema: accountDeletionStatusResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function cancelAccountDeletion(): Promise<AccountDeletionCancelledResponse> {
  return apiRequest({
    method: "POST",
    path: "/api/v1/me/deletion/cancel",
    schema: accountDeletionCancelledResponseSchema,
  });
}
