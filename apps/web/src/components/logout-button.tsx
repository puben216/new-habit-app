"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { markSigningOut, unmarkSigningOut } from "@/lib/api/query-client";
import { signOut } from "@/lib/auth/auth-client";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from "@/lib/auth/messages";
import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";

import { Button } from "./button";
import styles from "./logout-button.module.css";

/** ログアウト(docs/specs/auth-screens.md AUI-008)。成功したら query cache を破棄して `/login` へ。 */
export function LogoutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    // 進行中の取得が、ログアウト後の 401 を「期限切れ」として扱わないようにしてから送る。
    onMutate: async () => {
      markSigningOut(queryClient);
      await queryClient.cancelQueries();
    },
    mutationFn: () => signOut(),
    onError: () => {
      unmarkSigningOut(queryClient);
    },
    onSuccess: () => {
      queryClient.clear();
      router.replace("/login");
    },
  });

  const errorMessage = !mutation.isError
    ? null
    : isApiError(mutation.error) && mutation.error.code === CLIENT_ERROR_CODES.networkError
      ? NETWORK_ERROR_MESSAGE
      : UNEXPECTED_ERROR_MESSAGE;

  return (
    <div className={styles["root"]}>
      <Button variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        ログアウト
      </Button>
      {errorMessage === null ? null : (
        <p role="alert" className={styles["error"]}>
          {errorMessage}
        </p>
      )}
    </div>
  );
}
