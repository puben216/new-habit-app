import { getCleanup } from "./container";

/**
 * エクスポートの期限切れの削除の手動実行(`pnpm export:cleanup`。docs/runbooks/data-export.md)。
 * Lambda と同じ composition root・handler を使う。`DATA_EXPORT_ENABLED=true`、`DATABASE_URL`(または
 * `DATABASE_URL_SECRET_ARN`)、`AWS_REGION` が必要。標準出力には件数だけを出す。
 */
async function main(): Promise<number> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // .env がなくても、環境変数が直接設定されていればよい。
  }
  const result = await (await getCleanup())();
  console.log(JSON.stringify(result));
  return "disabled" in result ? 3 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // 例外の詳細(接続文字列・SQL など)を出力しない。
    console.error("実行に失敗しました。設定と DB への接続を確認してください。");
    process.exitCode = 1;
  },
);
