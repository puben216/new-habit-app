# ADR-011: 通知配送の非同期方式

Status: accepted
Date: 2026-10-09

Context:
T-402 でリマインドメールを重複なく送り、結果を監査できるようにする。制約は次のとおり。

- [ADR-004](ADR-004-hosting.md)・[docs/07](../07-infrastructure.md): 非同期処理は SQS + Lambda + DLQ。EventBridge Scheduler はユーザーごとの schedule を大量に作らず、一定間隔で対象 window を抽出して SQS へ投入する。
- [ADR-005](ADR-005-email.md): メールは Amazon SES(送信ドメインは未確定)。
- [AGENTS.md](../../AGENTS.md): queue consumer は at-least-once を前提に冪等にする。retry は一時的障害に限定し、回数上限・exponential backoff・jitter・DLQ を設ける。外部 API には timeout・abort・error classification を設ける。email や自由記述をログ・message に載せない。

Decision:

- **走査**: EventBridge Scheduler が 5 分ごとに scheduler Lambda を起動し、有効な設定を走査して送信枠(ローカル時刻 + timezone → UTC の瞬間)に達した配送を作る。配送の状態は DB(`notification_deliveries`)が正本で、`(設定, ローカル日)` の dedupe キーの UNIQUE で重複を防ぐ。
- **投入(outbox)**: 配送の作成と SQS への投入は別の操作とし、`enqueued_at` で投入済みを記録する。投入に失敗した行・古くなった行は次回の走査で再投入する。queue の message は配送 ID のみで、個人情報を載せない。
- **処理(claim)**: consumer は単一の条件付き `UPDATE`(`pending` かつ時刻到達かつ lease 切れ)で配送を取得し、他のワーカーと排他する。終端状態の行は更新しない。メール送信の直前に、設定の有効性・suppression・quiet hours・当日の記録を再確認する。
- **再試行**: 一時的な送信失敗は DB 上の状態(`next_attempt_at`、最大 5 回、exponential backoff + full jitter)で管理し、message は処理完了時に消費する。SQS の visibility timeout や SDK の自動再試行(`maxAttempts: 1`)には依存しない。予期しない例外(DB 障害など)は Lambda の部分失敗として message を残し、受信 3 回で DLQ へ移る。
- **フィードバック**: SES の configuration set の Bounce/Complaint を SNS → SQS で受け、Permanent bounce と complaint はユーザーを `email_suppressions` に記録して以後送らない。
- **配信停止**: メール本文のリンクと `List-Unsubscribe` / `List-Unsubscribe-Post`(RFC 8058)に、HMAC 署名つき token の公開 endpoint を使う。
- **Feature Flag**: `NOTIFICATION_DELIVERY_ENABLED`(既定 `false`)と、Scheduler の `ENABLED/DISABLED`(Terraform の `schedule_enabled`)を停止手段にする。
- **インフラ**: Terraform の `infra/modules/email` と `infra/modules/queue-worker`。Lambda ごとに IAM と環境変数を最小化し、Secret の値は state に入れない(Secrets Manager の器のみ作り、実行時に読む)。

Alternatives considered:

- ユーザーごとに EventBridge Scheduler の schedule を作る: 大量の schedule の作成・更新・削除が設定変更に連動し、timezone/DST の扱いも AWS 側に依存する。docs/07 の方針に反する。
- SQS の遅延(DelaySeconds)と visibility timeout で再試行を表現する: 最大遅延が 15 分で、試行回数・失敗理由の監査が DB に残らない。再試行の状態を DB に持つほうが dedupe・監査と整合する。
- 送信前に配送を `sending` 状態にして排他する: crash 時に `sending` のまま残る回復処理が別途必要になる。lease(`locked_until`)つきの claim のほうが単純で、期限切れで自動的に再取得できる。
- SES のテンプレート機能で本文を管理する: 本文が定型で小さく、テストしやすいアプリ側の組み立てを優先する。

Consequences:

- 送信成功後・記録前に crash すると、1 通重複して送られうる(SES に冪等キーがない)。lease 切れ後に再試行されるためで、頻度は低く影響は 1 通のリマインドに留まる。受容リスクとして Spec に記載する。
- 再試行の実効間隔は、再投入が 5 分周期のスケジューラで行われるため、backoff の値と 5 分の大きい方になる。
- 走査は有効な設定の全件を 5 分ごとに読む。規模が大きくなったら timezone 別の絞り込みなどが必要になる。
- 認証メール(確認・パスワード再設定)の SES 送信は本 ADR の対象外で、別タスクが必要。

Security/operational impact:

- 公開 endpoint は署名つき token が唯一の資格情報。鍵のローテーションは token の版数(`v1`)を使って後続で対応する。
- DLQ が 1 件でもあればアラームを出す。Runbook は [docs/runbooks/notification-delivery.md](../runbooks/notification-delivery.md)。

Review date: SES の送信ドメイン確定時、または配送の対象ユーザーが数千を超える前。
