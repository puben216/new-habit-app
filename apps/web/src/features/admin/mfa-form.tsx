"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary } from "@/components/error-summary";
import { FormStack } from "@/components/form-layout";
import { TextField } from "@/components/text-field";
import { verifyMfa } from "@/lib/admin/admin-api";
import { classifyAdminError, mfaErrorMessage } from "@/lib/admin/messages";

const CODE_REQUIRED_MESSAGE = "確認コードを入力してください。";

/**
 * MFA の検証フォーム(docs/specs/admin-screens.md ADS-002)。入力したコードは送信後すぐ state から消し、
 * 失敗時も復元しない(ADS-INV-006)。TOTP とリカバリーコードのどちらが誤りかは区別して表示しない。
 */
export function MfaForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: (value: string) => verifyMfa(value),
    onSuccess: () => {
      setError(null);
      router.replace(nextPath);
      // Server Component のガードに、検証済みの状態を再評価させる。
      router.refresh();
    },
    onError: (failure) => {
      const kind = classifyAdminError(failure);
      if (kind === "not_found") {
        // 管理者でなくなっている(無効化)。表示は server の判定に任せる。
        router.refresh();
        return;
      }
      setError(mfaErrorMessage(kind));
      setAttempt((value) => value + 1);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;

    const value = code.trim();
    if (value.length === 0) {
      setError(CODE_REQUIRED_MESSAGE);
      setAttempt((count) => count + 1);
      return;
    }
    setError(null);
    // 送信した時点で入力を消す(成功・失敗にかかわらず残さない)。
    setCode("");
    mutation.mutate(value);
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-busy={mutation.isPending}>
      <FormStack>
        <ErrorSummary
          items={error === null ? [] : [{ fieldId: "mfa-code", message: error }]}
          attempt={attempt}
        />
        <TextField
          id="mfa-code"
          name="code"
          label="確認コード"
          hint="認証アプリの 6 桁のコード、またはリカバリーコードを入力してください。"
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <div>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "確認しています" : "確認する"}
          </Button>
        </div>
      </FormStack>
    </form>
  );
}
