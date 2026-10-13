"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary } from "@/components/error-summary";
import { FormStack } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import {
  createDataExport,
  dataExportDownloadPath,
  dataExportsQueryKey,
  listDataExports,
} from "@/lib/account/export-api";
import {
  EXPORT_PASSWORD_REQUIRED_MESSAGE,
  EXPORT_STARTED_MESSAGE,
  classifyExportError,
  exportErrorMessage,
  exportFailureMessage,
  exportFormatLabel,
  exportStatusLabel,
  formatByteSize,
  isExportActive,
} from "@/lib/account/export-messages";
import { formatUtc } from "@/lib/format/utc";

import styles from "./account.module.css";

type Format = "json" | "csv";

const POLL_INTERVAL_MS = 2000;

/**
 * データエクスポートの作成と一覧(docs/specs/data-export.md EXP-008)。パスワードは送信した時点で state から
 * 消し、成功・失敗にかかわらず残さない。`queued`/`running` の間は 2 秒間隔で状態を更新し、終わったら止める。
 */
export function ExportPanel() {
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<Format>("json");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const list = useQuery({
    queryKey: dataExportsQueryKey,
    queryFn: ({ signal }) => listDataExports(signal),
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => isExportActive(item.status)) === true
        ? POLL_INTERVAL_MS
        : false,
  });

  const create = useMutation({
    mutationFn: (input: { password: string; format: Format }) =>
      createDataExport(input.password, input.format),
    onSuccess: () => {
      setError(null);
      setStarted(true);
      void queryClient.invalidateQueries({ queryKey: dataExportsQueryKey });
    },
    onError: (failure) => {
      setStarted(false);
      setError(exportErrorMessage(classifyExportError(failure)));
      setAttempt((value) => value + 1);
      // 実行中・頻度の上限などで失敗した場合も、最新の一覧を見せる。
      void queryClient.invalidateQueries({ queryKey: dataExportsQueryKey });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) return;
    if (password.length === 0) {
      setStarted(false);
      setError(EXPORT_PASSWORD_REQUIRED_MESSAGE);
      setAttempt((value) => value + 1);
      return;
    }
    const value = password;
    // 送信した時点で入力を消す(成功・失敗にかかわらず残さない)。
    setPassword("");
    setError(null);
    setStarted(false);
    create.mutate({ password: value, format });
  }

  const items = list.data?.items ?? [];

  return (
    <>
      <form onSubmit={handleSubmit} noValidate aria-busy={create.isPending}>
        <FormStack>
          <ErrorSummary
            items={error === null ? [] : [{ fieldId: "export-password", message: error }]}
            attempt={attempt}
          />
          <fieldset className={styles["fieldset"]}>
            <legend>形式</legend>
            <label className={styles["radio"]}>
              <input
                type="radio"
                name="format"
                value="json"
                checked={format === "json"}
                onChange={() => setFormat("json")}
              />
              JSON(1 つのファイル。そのまま読めます)
            </label>
            <label className={styles["radio"]}>
              <input
                type="radio"
                name="format"
                value="csv"
                checked={format === "csv"}
                onChange={() => setFormat("csv")}
              />
              CSV(データの種類ごとの CSV を ZIP にまとめます。Excel で開けます)
            </label>
          </fieldset>
          <TextField
            id="export-password"
            name="password"
            label="現在のパスワード"
            hint="本人確認のため、パスワードを入力してください。"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={create.isPending}
          />
          {started ? <p role="status">{EXPORT_STARTED_MESSAGE}</p> : null}
          <div className={styles["actions"]}>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "作成しています" : "エクスポートを作成する"}
            </Button>
          </div>
        </FormStack>
      </form>

      <section aria-labelledby="exports-heading" className={styles["section"]}>
        <h2 id="exports-heading">作成したエクスポート</h2>
        {list.isPending ? <StateMessage kind="loading" title="読み込んでいます" /> : null}
        {list.isError ? (
          <StateMessage
            kind="error"
            title="一覧を読み込めませんでした"
            description="時間をおいてもう一度お試しください。"
            action={<Button onClick={() => void list.refetch()}>もう一度試す</Button>}
          />
        ) : null}
        {list.isSuccess && items.length === 0 ? (
          <StateMessage kind="empty" title="まだエクスポートはありません" />
        ) : null}
        {items.length > 0 ? (
          <ul className={styles["list"]}>
            {items.map((item) => {
              const downloadPath = item.status === "ready" ? dataExportDownloadPath(item.id) : null;
              return (
                <li key={item.id} className={styles["exportItem"]}>
                  <p>
                    <strong>{exportFormatLabel(item.format)}</strong> ・ 作成日時{" "}
                    {formatUtc(item.requestedAt)}
                  </p>
                  <p>
                    状態: {exportStatusLabel(item.status)}
                    {isExportActive(item.status) ? "(自動で更新されます)" : ""}
                  </p>
                  {item.status === "failed" ? (
                    <p>{exportFailureMessage(item.failureCode)}</p>
                  ) : null}
                  {item.byteSize !== null && item.status !== "failed" ? (
                    <p>サイズ: {formatByteSize(item.byteSize)}</p>
                  ) : null}
                  {item.expiresAt !== null ? (
                    <p>
                      {item.status === "ready" ? "ダウンロードの期限" : "期限"}:{" "}
                      {formatUtc(item.expiresAt)}
                    </p>
                  ) : null}
                  {downloadPath === null ? null : <a href={downloadPath}>ダウンロード</a>}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </>
  );
}
