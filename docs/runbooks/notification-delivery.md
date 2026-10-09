# 通知配送 Runbook

対象: リマインド通知の配送([notification-delivery.md](../specs/notification-delivery.md)、[ADR-011](../adr/ADR-011-notification-delivery.md))。

構成: EventBridge Scheduler(5 分間隔)→ scheduler Lambda → SQS `notifications` → delivery Lambda → SES。SES の bounce/complaint → SNS → SQS `ses-feedback` → feedback Lambda。各 queue に DLQ。

## 禁止事項(必ず守る)

- email、token、配信停止 URL、SES の応答本文、DB の接続文字列をチケット・チャット・ログに貼らない。
- 調査では配送の内部 ID と状態だけを使う。ユーザーを特定する必要がある場合は権限のある担当者が DB で行う。

## 緊急停止

新しい配送の作成と送信を止める手順(上から順に。どれも可逆):

1. EventBridge Scheduler を無効にする(Terraform の `schedule_enabled = false` を適用、または緊急時はコンソールで `${name_prefix}-reminder-scan` を DISABLED にする。コンソールで変更した場合は、後で Terraform の値を合わせて drift を解消する)。→ 新しい配送が作られなくなる。
2. Lambda の環境変数 `NOTIFICATION_DELIVERY_ENABLED` を `false` にする(Terraform の `delivery_enabled = false`)。→ scheduler と delivery は何もしない(queue の message は消費され、配送は `pending` のまま残る)。
3. それでも送信が続く場合は、delivery Lambda の event source mapping を無効化するか、reserved concurrency を 0 にする。

再開: 原因を解消し、`delivery_enabled = true` → `schedule_enabled = true` の順に戻す。`pending` のまま残った配送は、許容遅延(60 分)内なら自動的に再投入されて送られ、過ぎていれば `expired` になる。

## アラームと一次対応

| アラーム                                                         | 意味                                        | 一次対応                                                                |
| ---------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| `*-notifications-dlq-not-empty`                                  | 配送の処理が 3 回続けて例外になった message | 下の「DLQ の確認と redrive」                                            |
| `*-feedback-dlq-not-empty`                                       | bounce/complaint の処理が失敗した message   | 同上。suppression の記録漏れの可能性があるので優先して確認              |
| `*-notifications-oldest-message-age`                             | notifications queue に 30 分以上の滞留      | delivery Lambda のエラー・throttle、DB 接続、SES のスロットリングを確認 |
| `*-scheduler-errors` / `*-delivery-errors` / `*-feedback-errors` | Lambda のエラー                             | CloudWatch Logs の要約ログ(件数のみ)と DB の状態を確認                  |

## DLQ の確認と redrive

1. DLQ のメッセージ数と、直近の Lambda エラー(CloudWatch Logs の `notification.delivery` / `notification.feedback` の `errors` 件数)を確認する。メッセージ本文は配送 ID だけだが、不要に取り出さない。
2. 原因(多くは DB 障害・接続枯渇・デプロイ不具合)を解消する。
3. 原因が解消してから、SQS の redrive(DLQ → 元の queue)を実行する。delivery は冪等なので、すでに送信済みの配送を再処理しても二重に送られない(終端状態は更新されず `noop`)。
4. DLQ が空になったことと、`notification_deliveries` の `pending` が減っていることを確認する。
5. 原因が解消できない message は、配送の `status` を確認し、`pending` のまま放置してよいか(許容遅延を過ぎれば次の走査で `expired` 相当の扱い)を判断する。DLQ から削除する前に、対象の配送 ID を記録する。

## スケジューラが止まっていた場合

許容遅延(60 分)を過ぎた送信枠の配送は作られず、再開後に古い枠をまとめて送ることもない(その日のリマインドは送られない)。止まっていた時間と対象日を記録し、必要なら利用者向けの告知を検討する。

## 配送の状態の確認

`notification_deliveries.status` は `pending | sent | skipped | expired | suppressed | failed`。`failure_code` の主な値:

| failure_code                                                                                                                                    | 意味                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `disabled`                                                                                                                                      | 送信前に設定が無効になっていた             |
| `already_recorded`                                                                                                                              | 当日の予定がすべて記録済み                 |
| `no_recipient`                                                                                                                                  | 宛先が取得できない(email 未確認・削除済み) |
| `retries_exhausted`                                                                                                                             | 一時的な失敗が 5 回続いた                  |
| `throttled` / `timeout` / `server_error` / `network_error`                                                                                      | 一時的な送信失敗(再試行の途中経過)         |
| `rejected` / `domain_not_verified` / `account_suspended` / `sending_paused` / `bad_request` / `not_found` / `client_error` / `invalid_response` | SES が永続的に拒否・異常                   |

`rejected` が多発する場合は、SES が sandbox のまま(未検証の宛先に送れない)でないか、送信ドメインの検証・DKIM が有効かを確認する(ADR-005)。

## suppression の確認と解除

- bounce(Permanent)/complaint を受けたユーザーは `email_suppressions` に記録され、設定が有効でも送られない。
- 解除は原則しない。誤って記録された場合のみ、権限のある担当者が理由(チケット)を残したうえで該当行を削除する。SES の account-level suppression list にも同じアドレスが入っている場合があるので、SES 側も確認する。
- complaint が増えたら送信を止め(緊急停止)、本文・頻度・配信停止リンクの動作を確認する。SES の reputation 指標(bounce 率・complaint 率)を監視する。

## 配信停止リンクの署名鍵のローテーション

鍵(Secrets Manager の `unsubscribe-signing-key`)を替えると、すでに送られたメールの配信停止リンクがすべて無効になる。複数鍵の同時許容は未実装のため、鍵の漏えいが疑われる場合のみ実施し、実施前にその影響(過去のメールからの配信停止ができなくなる)を関係者に共有する。手順: 新しい鍵を投入 → web(ECS)と delivery Lambda を再起動(コールドスタート)→ 動作確認。鍵の値は state・チャット・ログに残さない。

## 初回の有効化チェックリスト(実送信の前)

- [ ] SES の送信ドメインの検証・DKIM・SPF・DMARC が完了している(ADR-005)。未完了の間は sandbox の verified address だけで検証する。
- [ ] `unsubscribe-signing-key` の値を投入済みで、web と delivery Lambda が同じ値を使っている。
- [ ] 配信停止リンク(POST)が動くことを、sandbox のメールで確認した。
- [ ] DLQ アラームの通知先(SNS トピックの購読者)が設定されている。
- [ ] `delivery_enabled = true` にしてから `schedule_enabled = true` にする。
