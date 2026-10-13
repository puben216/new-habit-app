# データエクスポートの Runbook

対象: データエクスポート([data-export.md](../specs/data-export.md))。

## 仕組み(要点)

- 利用者がパスワードを再入力して `POST /api/v1/me/exports` を呼ぶと、エクスポートが `queued` で作られ、queue に投入される。worker が `running` → `ready`(または `failed`)にし、成果物(JSON、または CSV の ZIP)を DB の `data_export_artifacts` に保存する。
- 完成から **24 時間** だけ、本人がダウンロードできる。期限後は `410`。日次のクリーンアップが成果物を削除し(`expired`)、`failed`/`expired` から 7 日を過ぎた行を削除する。
- 同時に実行できるのは 1 件。24 時間に 5 件まで。上限は 20 MiB。60 分以上更新のない `queued`/`running` は停止したとみなし、作成時と日次のクリーンアップで `failed(worker_error)` にする(利用者が作り直せなくなることを防ぐ)。
- ローカル/E2E は同一プロセスの inline queue。本番相当の queue(SQS)と Lambda は T-501 で配置する(それまでは本番相当の環境ではエクスポートは動かない)。

## 禁止事項

- 利用者のエクスポートの中身(習慣名・メモ・メール・成果物の本文)を、チケット・チャット・ログに貼らない。調査は公開 ID(UUID)と状態・失敗コードで行う。
- `data_export_artifacts.content` を取り出して送付・保存しない。利用者は自分で再作成できる。
- DB を直接更新して状態を書き換えない(CHECK 制約があり、監査も残らない)。

## クリーンアップの手動実行

前提: DB の接続情報を持つ環境で、`DATA_EXPORT_ENABLED=true`、`DATABASE_URL`(または `DATABASE_URL_SECRET_ARN`)、`AWS_REGION` を設定する。

```text
pnpm export:cleanup
```

- 出力は件数だけ(`{"expired":N,"staleFailed":N,"deleted":N}`)。Feature Flag が無効なら DB に接続せず終了コード 3 で終わる。
- 1 回の実行は最大 200 件。何度実行しても安全(冪等)。

## 問い合わせへの対応

### 「エクスポートが完成しない」

1. 本人確認のうえ、管理画面のユーザー検索で公開 ID を特定する。
2. 状態を確認する(個人情報は含まない)。

```sql
SELECT public_id, format, status, failure_code, created_at, updated_at, expires_at
FROM data_exports
WHERE user_id = (SELECT id FROM users WHERE public_id = '<ユーザーの公開 ID>')
ORDER BY created_at DESC LIMIT 5;
```

3. 状態ごとの対応:
   - `queued` のまま長い: worker(queue の consumer)が止まっている。Feature Flag `DATA_EXPORT_ENABLED`、queue の滞留、DLQ を確認する。60 分を過ぎると自動で `failed(worker_error)` になり、利用者は作り直せる。
   - `running` のまま長い: lease(5 分)を過ぎれば別の worker が引き継ぐ。それでも進まない場合は worker のログ(件数のみ)と DB を確認する。
   - `failed`: `failure_code` を見る。`too_large`(20 MiB 超)は分割の仕組みが無いため、データ量を確認して開発チームに相談する。`worker_error`/`generation_failed` は開発チームへ。`enqueue_failed` は queue への投入の障害(利用者はやり直せる)。
4. 利用者には、`failed`/`expired` の場合は新しく作成し直してもらう(24 時間に 5 件まで)。

### 「ダウンロードできない」

- `410`: 完成から 24 時間を過ぎている。新しく作成し直してもらう。
- `409`: まだ完成していない、または失敗している。
- `404`: 他のアカウントのもの、または存在しない。本人のアカウントでログインしているか確認する。

## 確認用のクエリ

```sql
-- 状態ごとの件数
SELECT status, count(*) FROM data_exports GROUP BY status ORDER BY status;

-- 古い queued(worker の滞留の確認)
SELECT count(*) FROM data_exports WHERE status = 'queued' AND created_at < now() - interval '15 minutes';

-- 期限が過ぎているのに残っている成果物(クリーンアップが止まっていないかの確認)
SELECT count(*) FROM data_exports WHERE status = 'ready' AND expires_at <= now() - interval '1 hour';

-- 直近 7 日の作成とダウンロードの件数(監査)
SELECT action, count(*) FROM audit_logs
WHERE action LIKE 'user.export.%' AND created_at >= now() - interval '7 days'
GROUP BY action;
```

「期限が過ぎているのに残っている」が続く場合は、クリーンアップが動いていない(Feature Flag が無効、スケジュール未配置)。上の手動実行で件数を確認する。

## 配置(T-501 以降)

- export queue(SQS)・DLQ・consumer の Lambda(`data-export`)・日次のクリーンアップ(`data-export-cleanup`)を Terraform で配置する。最初は `DATA_EXPORT_ENABLED=false` で配置し、手動実行で動作を確認してから有効にする。Flag が無効の間に届いた message は処理せず queue に残る。
- Web 側は `EXPORT_QUEUE_DRIVER=sqs`(adapter は T-501 で実装)。本番では `inline` は拒否される。
- 成果物の保存は DB から S3(暗号化、短期限 presigned URL、lifecycle)へ移行する。移行時は `data_exports` にオブジェクトキーを持たせる Migration を追加する。

## 保持・削除

- 成果物は最長 24 時間。アカウントを削除すると(猶予 30 日後の物理削除)、エクスポートの行と成果物も CASCADE で削除される。
- DB のバックアップに成果物が含まれる期間は、バックアップ基盤(T-502)の保持期間に従う。
