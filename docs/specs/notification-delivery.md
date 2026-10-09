# 通知のスケジュールと配送 Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-09
変更区分: Standard
ロードマップ項目: T-402

## 目的

T-401 で保存された通知設定(opt-in、送信時刻、quiet hours、timezone)に従い、習慣の記録リマインドを email で重複なく送り、結果を監査できるようにする(UC-15)。あわせて、受信者が 1 クリックで配信を止められる経路(RFC 8058)と、bounce/complaint を受けた宛先へ二度と送らない仕組み(suppression)を提供し、メール送信を始める前提条件(T-401 の受容リスク)を満たす。

## 成功指標

- 同じ `(設定, ローカル日)` に対して、スケジューラの重複実行・メッセージの重複配信・並行ワーカーがあっても、`notification_deliveries` の行は 1 件で、メールが重複して送られる確率を「送信後・記録前のクラッシュ」の場合に限定できている(Integration Test で並行 claim を確認)。
- 許容遅延(60 分)を過ぎた配送、quiet hours に入ってしまった配送は送られず `expired` になる(Unit/Integration Test)。
- 無効化済み・suppression 済み・当日の予定がすべて記録済みのユーザーには送られない。
- メール内の配信停止リンク(POST)だけで設定が無効になり、再実行しても結果が同じ(冪等)。
- bounce(Permanent)/complaint を受けたユーザーは、設定が有効でも以後送られない。
- キュー message・ログ・メトリクスに email、習慣名、メモ等の個人情報が含まれない(Unit Test と設計で確認)。

## 範囲

- Domain(notifications): ローカル時刻 → UTC 時刻の変換 `resolveReminderSlot`(DST 対応)、配送の状態遷移と判定(`ReminderDeliveryStatus`、再試行の backoff/jitter 計算、許容遅延)。
- Application: `scheduleDueRemindersUseCase`(走査・dedupe・投入)、`deliverReminderUseCase`(claim・判定・送信・結果記録)、`handleEmailFeedbackUseCase`(bounce/complaint)、`unsubscribeUseCase`、リマインド本文の組み立て(定型)、各 port(`ReminderDeliveryRepositoryPort`、`ReminderQueuePort`、`ReminderEmailPort`、`UnsubscribeTokenPort`、`EmailSuppressionPort` 等)。
- Infrastructure: Prisma repository 群、署名付き配信停止 token(HMAC)、SES adapter(AWS SDK v3 `SESv2`)、SQS producer、Secrets Manager 読み込み。
- Presentation: 公開 endpoint `GET/POST /api/v1/notification-unsubscribe`(`apps/web`)、Lambda handler(`apps/workers`: scheduler、delivery consumer、SES feedback consumer)。
- DB: Migration 1 本(`notification_deliveries` の列・制約・index 追加、`email_suppressions` 新設、`notification_settings` の走査用 index)。
- Terraform(`infra/`): `modules/email`(SES identity、DKIM、configuration set、bounce/complaint 用 SNS)、`modules/queue-worker`(notifications SQS + DLQ、feedback SQS + DLQ、Lambda、最小権限 IAM、EventBridge Scheduler、DLQ アラーム)、`environments/dev`(これらを呼ぶ最小構成)。`terraform apply` はしない(fmt/validate まで)。
- 文書: `docs/04`、`docs/05`、`docs/07`、`docs/09`、`docs/10`、`docs/adr`(新しい ADR)。

## 対象外

- 習慣ごとの通知時刻・本文への習慣名の差し込み(個人の内容をメールに載せない。定型本文のみ)。
- 通知設定の UI、unsubscribe の確認画面の本格的な UI(最小の HTML 応答のみ)、Playwright E2E(基盤未導入)。
- network/RDS/ECS/KMS 等の共通基盤(T-501)、本番環境(T-502)、デプロイ pipeline・Lambda の成果物ビルド/昇格(T-503)、`terraform apply`、実際の SES 送信ドメインの取得・検証(別途。ADR-005)。
- SES の account-level suppression list の運用手順、soft bounce の統計、送信量の上限制御、Rate limit(P2 未決)。
- Admin 画面での配送失敗確認(T-403)。本タスクは配送結果を DB に残すところまで。
- 認証メール(email 確認・パスワード再設定)の SES 送信。`EmailSenderPort`(auth)の SES 実装は本 Spec の対象外で、本番で認証メールを送るには別タスクが必要(未割当。Open Questions 参照)。
- アドレス単位の suppression(メールアドレス変更・再登録が存在しないため user 単位。未決事項参照)。

## アクターと前提条件

| アクター                            | 前提条件                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Scheduler(EventBridge → Lambda)     | 5 分間隔で起動。DB と notifications queue へ書き込める最小権限                    |
| Worker(SQS → Lambda)                | notifications queue の message を受ける。DB、SES 送信、Secrets 読み取りの最小権限 |
| Feedback worker(SNS → SQS → Lambda) | SES の bounce/complaint 通知を受ける。DB の suppression 書き込みのみ              |
| 受信者(メールの Member)             | 配信停止リンクの署名付き token を持つ。ログイン不要                               |
| Member                              | T-401 の設定を保存済み(`enabled = true`)。email 確認済み                          |

## 機能要件

### NDL-001 送信予定の作成(window scan と dedupe)

- `scheduleDueRemindersUseCase` は、有効な設定(`enabled = true`、`habit_id IS NULL`、`channel = 'email'`)を id の昇順でページ(500 件)ごとに走査する。
- 各設定について、現在時刻 `now` を設定の timezone に直したローカル日と、その前日の 2 日分を候補とする(日付境界の直後に前日 23:xx の枠を拾うため)。各候補日の送信枠 `slot` は Domain の `resolveReminderSlot(localDate, localTime, timezone)` で求める。
- `slot <= now < slot + 許容遅延(60 分)` を満たす枠について、`notification_deliveries` へ `status = 'pending'` の行を作る。重複排除キーは `reminder:{設定の内部 ID}:{ローカル日}`。`INSERT ... ON CONFLICT (deduplication_key) DO NOTHING` の単一文で、スケジューラが何度走っても 1 行になる。
- 許容遅延を過ぎた枠(スケジューラ停止等)は行を作らない(送らない)。
- 1 回の実行で作成した件数・走査した件数をメトリクス用の戻り値で返す(個人情報を含まない)。

### NDL-002 キュー投入と再投入(outbox)

- 行の作成後に、`ReminderQueuePort.enqueue` で `deliveryId` のみを含む message を投入する。投入に成功した行は `enqueued_at = now` にする。
- 同じ実行で、`status = 'pending'` かつ `next_attempt_at <= now` かつ(`enqueued_at IS NULL` または `enqueued_at < now - 10 分`)の行を再投入する。これにより、投入失敗・message 消失・再試行待ちの行が自動的に再度キューへ載る。
- message は `deliveryId` だけを持つ(email、user ID、習慣名を含めない)。消費側は at-least-once を前提に冪等に処理する。

### NDL-003 配送の実行

`deliverReminderUseCase(deliveryId)` は次の順で処理する。どの結果も DB に記録し、終端状態の行は二度と変更しない。

1. **claim**: `status = 'pending'` かつ `next_attempt_at <= now` かつ lease が切れている行を `locked_until = now + 5 分`、`attempt_count + 1` に更新して取得する(単一 `UPDATE ... RETURNING`)。取得できなければ何もせず成功扱い(重複 message・並行ワーカー・終端済み)。
2. **期限**: `now >= scheduled_at + 許容遅延` なら `expired`。
3. **設定**: ユーザー単位の設定が存在しない、または `enabled = false` なら `skipped`(`failure_code = disabled`)。
4. **suppression**: `email_suppressions` にユーザーがいれば `suppressed`。
5. **quiet hours**: 設定の timezone での現在のローカル時刻が quiet hours 内なら `expired`(遅延で枠が quiet hours に入った場合)。
6. **記録済み**: 配送の `local_date` について、ユーザーの active な習慣のうちその日に予定された習慣がないか、すべてに記録(`success`/`missed`/`skipped`)があれば `skipped`(`failure_code = already_recorded`)。
7. **宛先**: ユーザーの email(確認済み)を取得する。取得できなければ `failed`(`no_recipient`)。
8. **送信**: `ReminderEmailPort.send`。成功なら `sent`(`provider_message_id`、`sent_at`)。

### NDL-004 失敗の分類・再試行・DLQ

- `ReminderEmailPort` は失敗を `transient`(タイムアウト、429、5xx、スロットリング)と `permanent`(4xx の不正な宛先・拒否・設定不備)に分類して投げる。
- `transient`: `attempt_count < 5` なら `pending` のまま `next_attempt_at = now + backoff` にし、`locked_until` を解除する。backoff は `min(15 分, 60 秒 × 2^(attempt-1))` に full jitter(0〜上限の一様乱数)。`attempt_count >= 5` なら `failed`(`failure_code = retries_exhausted`)。
- `permanent`: 再試行せず `failed`(`failure_code` は分類コード)。
- 再試行は DB 上の状態として管理し、message は処理が完了した時点で消費する(SQS の visibility timeout に再試行を依存しない)。予期しない例外(DB 障害等)は Lambda の失敗として message を残し、SQS の redrive(受信 3 回)後に DLQ へ移る。DLQ に 1 件でもあればアラームを出す。
- 外部呼び出し(SES)は明示的な timeout(10 秒)と abort を持つ。

### NDL-005 期限切れ

- 許容遅延(60 分)を過ぎた配送は送らず `expired` にする(`docs/02` 例外・競合)。許容遅延は Domain の定数 `REMINDER_MAX_LATENESS_MINUTES`(暫定、P2 相当)。

### NDL-006 メールの内容

- 件名・本文は固定の定型文で、習慣名・メモ・気分などユーザー固有の内容、表示名を含めない。本文は「今日の習慣を記録しましょう」旨と、アプリへのリンク(`APP_BASE_URL`)、配信停止リンクのみ。
- ヘッダー `List-Unsubscribe: <配信停止 URL>` と `List-Unsubscribe-Post: List-Unsubscribe=One-Click` を付ける。
- 送信元は環境変数 `EMAIL_FROM`。SES の configuration set を指定し、bounce/complaint を受け取れるようにする。

### NDL-007 ワンクリック配信停止

- 配信停止 URL は `{APP_BASE_URL}/api/v1/notification-unsubscribe?token={署名付き token}`。token は `v1.{base64url(payload)}.{base64url(HMAC-SHA256)}`。payload は `{ purpose: "reminder-unsubscribe", sub: <ユーザーの公開 ID> }` のみで、内部 ID・email を含めない。署名鍵は `UNSUBSCRIBE_SIGNING_KEY`(32 文字以上)。メール内のリンクは有効期限を設けない(RFC 8058 の運用上、古いメールからも停止できるため)。
- `POST /api/v1/notification-unsubscribe?token=...`(body は `List-Unsubscribe=One-Click` の form、または空)は、token が有効なら該当ユーザーの設定を `enabled = false` にし、`200` を返す。設定が無い・既に無効でも `200`(冪等)。token が不正・改ざん・用途違いなら `400`(`invalid_token`、理由を区別しない)。
- `GET` は状態を変えず、確認用の最小 HTML(「配信を停止する」ボタンが POST を送る)を返す。token が不正でも同じ HTML を返さず `400`。
- この endpoint は認証不要(token が唯一の資格情報)のため、Origin 検証は行わず、token の用途・署名で保護する。状態変更は POST のみ。

### NDL-008 bounce/complaint と suppression

- SES の configuration set イベント(Bounce、Complaint)は SNS → SQS で feedback worker が受ける。`handleEmailFeedbackUseCase` は `provider_message_id` から配送とユーザーを引く。
- Bounce の `bounceType = Permanent`、または Complaint なら、`email_suppressions` にユーザーを `INSERT ... ON CONFLICT (user_id) DO NOTHING` する(冪等)。`Transient`/`Undetermined` は suppression しない。
- 未知の `provider_message_id`、形式不正なイベントは無視して成功扱い(再処理しても結果が同じ。DLQ に流さない)。不正 JSON は DLQ ではなく破棄し、件数をメトリクスにする。
- suppression 済みのユーザーは、T-401 の設定を再度有効にしても以後送られない(NDL-003 の 4)。

### NDL-009 インフラ(Terraform)

- 上記の Lambda、SQS、SNS、SES identity/configuration set、EventBridge Scheduler、IAM、DLQ アラームを Terraform で定義する(fmt/validate/plan 可能な状態まで。apply しない)。Secret の値は state に入れず、Secrets Manager の器のみを作る。

## 業務ルールと不変条件

- NDL-INV-001(一意性): `(設定, ローカル日)` あたり配送は高々 1 件(`deduplication_key` の UNIQUE)。
- NDL-INV-002(終端の不変): `sent`/`skipped`/`expired`/`suppressed`/`failed` の行は更新しない(`UPDATE ... WHERE status = 'pending'`)。
- NDL-INV-003(opt-in): 送信の直前に、設定が存在し `enabled = true` であることを毎回再確認する(スケジューラが行を作った後の停止に追従する)。
- NDL-INV-004(宛先の最小露出): email はワーカーが送信直前に取得し、message・ログ・DB の配送行に保存しない。
- NDL-INV-005(message の最小化): キュー message は `deliveryId`(内部 ID の十進文字列)のみ。
- NDL-INV-006(時刻の解釈): 送信枠はローカル日付 + ローカル時刻 + timezone から UTC の瞬間へ変換する。存在しないローカル時刻(DST の spring-forward)は、その gap の直後の最初の瞬間に送る。曖昧なローカル時刻(fall-back)は早い方の瞬間に 1 回だけ送る。
- NDL-INV-007(再試行の上限): 1 配送あたりの試行は最大 5 回。
- NDL-INV-008(許容遅延と backoff の定数): 許容遅延 60 分、lease 5 分、再投入 10 分、backoff 上限 15 分は Domain/Application の定数 1 箇所のみで定義する(暫定値)。
- NDL-INV-009(suppression の優先): suppression 済みユーザーには、設定の有効無効に関わらず送らない。

## 状態遷移

| 現在    | イベント                                            | 次           | 備考                                |
| ------- | --------------------------------------------------- | ------------ | ----------------------------------- |
| (なし)  | スケジューラが枠を検出                              | pending      | dedupe キーで 1 件                  |
| pending | 送信成功                                            | sent         | `provider_message_id`、`sent_at`    |
| pending | 許容遅延超過、または quiet hours に入った           | expired      |                                     |
| pending | 設定なし/無効、当日の予定が記録済み                 | skipped      | `failure_code` に理由               |
| pending | suppression 済み                                    | suppressed   |                                     |
| pending | 一時的な送信失敗(試行 5 回未満)                     | pending      | `next_attempt_at` を backoff で更新 |
| pending | 一時的な送信失敗(試行 5 回)、永続的な失敗、宛先なし | failed       | `failure_code` に分類               |
| 終端    | 任意                                                | (変更しない) | 重複 message は no-op               |

## 受け入れ基準

```gherkin
シナリオ: 送信枠の中で 1 件だけ作る
  前提 ユーザーの設定が enabled=true、localTime=08:00、timezone=Asia/Tokyo
  かつ 現在が 2026-01-14T23:02:00Z(東京で 2026-01-15 08:02)
  もし スケジューラを 2 回実行する
  ならば deduplication_key "reminder:{設定ID}:2026-01-15" の配送が 1 件、pending で作られる
  かつ queue には deliveryId のみの message が投入される

シナリオ: 枠より前・許容遅延より後は作らない
  前提 同じ設定
  もし 現在が 07:59(東京)と 09:01(東京)でそれぞれ実行する
  ならば どちらも配送は作られない

シナリオ: 日付境界をまたぐ枠
  前提 localTime=23:50、timezone=Asia/Tokyo
  もし 現在が東京の翌日 00:10 に実行する
  ならば 前日(東京)の枠 23:50 の配送が作られる

シナリオ: DST の存在しない時刻
  前提 timezone=America/New_York、localTime=02:30、2026-03-08(spring-forward)
  ならば 枠は 2026-03-08T07:00:00Z(現地 03:00 EDT)になる

シナリオ: DST の曖昧な時刻
  前提 timezone=America/New_York、localTime=01:30、2026-11-01(fall-back)
  ならば 枠は早い方の 2026-11-01T05:30:00Z(現地 01:30 EDT)で 1 回だけ作られる

シナリオ: 送信成功
  前提 pending の配送、設定は有効、suppression なし、当日の予定が未記録、宛先あり
  もし ワーカーが deliveryId を処理する
  ならば SES へ 1 回送信し、status=sent、provider_message_id と sent_at が保存される
  かつ 同じ message をもう一度処理しても送信されない

シナリオ: 並行ワーカー
  もし 同じ deliveryId を 6 並行で処理する
  ならば 送信は 1 回だけで、他は no-op

シナリオ: 当日の予定がすべて記録済み
  前提 その日に予定された習慣すべてに記録がある
  ならば status=skipped(already_recorded)で送信しない

シナリオ: 許容遅延と quiet hours
  前提 scheduled_at から 61 分後に処理する
  ならば status=expired
  かつ 遅延で現在が quiet hours に入った場合も expired

シナリオ: 無効化・suppression
  前提 スケジューラの後にユーザーが配信停止した
  ならば status=skipped(disabled)で送信しない
  かつ suppression 済みなら status=suppressed

シナリオ: 一時的失敗の再試行
  前提 SES が 429 を返す
  ならば pending のまま attempt_count=1、next_attempt_at が backoff 後に更新される
  かつ 5 回目の失敗で failed(retries_exhausted)
  かつ 4xx の永続エラーは 1 回で failed

シナリオ: 取りこぼした message の再投入
  前提 pending で enqueued_at が NULL(投入失敗)、または 10 分以上前
  もし スケジューラが次に走る
  ならば その配送が再投入される

シナリオ: ワンクリック配信停止
  前提 有効な token
  もし POST /notification-unsubscribe?token=... を 2 回呼ぶ
  ならば どちらも 200 で、設定は enabled=false(2 回目も同じ結果)
  かつ 改ざんした token・別用途の token は 400 invalid_token

シナリオ: bounce と complaint
  前提 sent の配送の provider_message_id に対する Permanent bounce
  ならば email_suppressions にユーザーが 1 件入る(再通知しても 1 件)
  かつ Transient bounce は suppression しない
  かつ 未知の message ID は無視して成功
```

## 認可マトリクス

| 操作                            | Guest | Member | Admin | 所有権ルール                                           |
| ------------------------------- | ----: | -----: | ----: | ------------------------------------------------------ |
| POST /notification-unsubscribe  | token |  token | token | token の `sub`(ユーザー)の設定のみ。session は使わない |
| GET /notification-unsubscribe   | token |  token | token | 状態を変えない確認 HTML のみ                           |
| scheduler / delivery / feedback |     — |      — |     — | Lambda の IAM のみ。公開 endpoint を持たない           |

Admin 画面での配送確認は T-403。配送・suppression を Member が参照・変更する API は作らない。

## APIとイベント

- `POST/GET /api/v1/notification-unsubscribe`: 上記 NDL-007。入力は query `token`(最大 512 文字)のみ。応答は `200`(POST、本文なし `{ "status": "unsubscribed" }`)、`400 invalid_token`、`Cache-Control: no-store`。GET は `text/html`。
- キュー message(notifications): `{ "version": 1, "deliveryId": "<十進文字列>" }`。受信側は runtime schema で検証し、不正な message は破棄して失敗扱いにしない(ログに内容を出さない)。
- SES イベント(feedback): SNS 通知に包まれた SES の Bounce/Complaint イベントのうち、`eventType`、`mail.messageId`、`bounce.bounceType` のみを runtime schema で読む。
- SQS batch 応答は `batchItemFailures`(部分失敗)で返す。
- OpenAPI 生成基盤は未導入のため、契約の正本は `packages/contracts` の schema と本 Spec。

## データとMigration

Migration `t402_notification_delivery`(expand のみ。`notification_deliveries` は T-401 以前にアプリが書いておらず既存行がない前提):

- `notification_deliveries`:
  - 列追加: `user_id bigint NOT NULL`(FK `users` `ON DELETE CASCADE`)、`local_date date NOT NULL`、`next_attempt_at timestamptz NOT NULL`、`enqueued_at timestamptz`、`locked_until timestamptz`。
  - CHECK: `status IN ('pending','sent','skipped','expired','suppressed','failed')`、`attempt_count BETWEEN 0 AND 5`。
  - index: `(user_id)`(FK 用)、`(next_attempt_at) WHERE status = 'pending'`(再投入の走査)、`UNIQUE (provider_message_id) WHERE provider_message_id IS NOT NULL`(feedback の引き当て)。既存の `deduplication_key` UNIQUE と `notification_setting_id` index はそのまま。
- `email_suppressions`(新設): `id bigserial`、`user_id bigint NOT NULL UNIQUE`(FK `users` `ON DELETE CASCADE`)、`reason text NOT NULL CHECK (reason IN ('bounce','complaint'))`、`created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`。FK `user_id` の index は UNIQUE が兼ねる。
- `notification_settings`: 走査用の部分 index `(id) WHERE enabled AND habit_id IS NULL AND channel = 'email'`。
- 時刻は `timestamptz`(UTC)、`local_date` は `date`。保持期間: 配送行は T-404 の削除フロー(CASCADE)に従う。長期の保持・パージ方針は未決事項。
- アクセスパターン: スケジューラの設定走査(上記 index)、再投入(`next_attempt_at` の部分 index)、claim(PK)、feedback(`provider_message_id`)。
- 検証: fresh database と、直前の Migration までの既存 schema からの upgrade の両方を Integration Test で確認する。
- ロールバック: expand のみ。アプリを revert すれば足り、必要なら DROP する forward Migration を追加する(適用済み Migration は編集しない)。

## 失敗・境界ケース

- スケジューラが長時間止まった: 許容遅延を過ぎた枠は作られず、再開後に古い枠を一斉送信しない。
- 同じ設定で timezone や localTime を変更した直後: 既に作られた当日の配送は旧設定の枠のまま。送信前に設定を再確認し、無効なら skipped、quiet hours に入っていれば expired(NDL-INV-003)。新しい枠は新しい dedupe キーではなく同じ `(設定, ローカル日)` のため、同日に二重には作られない(受容リスク参照)。
- 送信成功後・記録前のワーカー crash: lease 切れ後に再試行され、メールが重複しうる(SES に冪等キーがない。受容リスク)。
- SES のスロットリング: transient として backoff 再試行。`attempt_count` が上限なら failed。再試行の実際の間隔は、再投入がスケジューラの実行(5 分間隔)で行われるため、backoff の値と 5 分の大きい方になる。5 回の試行は許容遅延(60 分)内に収まる。
- sandbox(未検証の宛先)への送信拒否: permanent として failed(`rejected`)。
- email 未確認・削除済みユーザー: 宛先なしで failed(`no_recipient`)。ユーザー削除は CASCADE で配送ごと消える。
- 不正な token(空、長すぎる、base64 不正、署名不一致、別用途、未知の公開 ID): すべて `400 invalid_token`。署名の比較は定数時間。
- queue message の不正(JSON でない、schema 違反): 破棄して成功扱いにし、件数のみ記録する(DLQ を汚さない)。
- DB 障害: 例外として Lambda を失敗させ、message を SQS に残す(DLQ へ)。

## セキュリティとプライバシー

- 収集データ: 配送の結果(状態、試行回数、SES の message ID、失敗コード)、suppression(ユーザー ID と理由)。
- 外部送信データ: SES へ宛先 email、定型の件名・本文、配信停止 URL。習慣名・メモ・表示名は送らない。
- ログ禁止データ: email、token、配信停止 URL、SES の応答本文、request body、cookie、session、設定値の組。ログにはカウントと配送の内部 ID 以外を出さない。
- 脅威と対策:
  - 配信停止 token の偽造・改ざん: HMAC-SHA256 と定数時間比較、用途(`purpose`)の検証、署名鍵は Secrets Manager。鍵のローテーションは `v1` の版数と複数鍵の許容で後続対応(未決事項)。
  - token からの情報漏えい: payload に公開 ID のみ。内部 ID・email を含めない。
  - 公開 endpoint の abuse: token 検証前に DB へ触れない。入力長の上限。Rate limit は未実装(受容リスク)。GET は状態を変えないため、メーラーのプリフェッチで勝手に停止されない。
  - なりすまし送信: DKIM/SPF/DMARC を Terraform と ADR-005 の follow-up で必須とする。
  - 誤送信: 宛先は送信直前にユーザー ID から取得し、設定から指定できない。opt-in を毎回再確認する。
  - queue の replay・重複: 終端状態の不変と claim で冪等。message に機微情報を載せない。
  - IAM: scheduler は queue 送信と DB のみ、worker は SES `SendEmail` と DB と Secrets 読み取りのみ、feedback は DB のみ。SES の `FromAddress`/identity を条件で絞る。
- 個人情報の影響: 通知の送信と bounce の記録は個人データの処理。T-404 のエクスポート/削除の対象に配送行と suppression を含める(CASCADE)。

## AI要件

N/A。AI を利用しない。通知の文面は固定の定型文で、モデルに送信可否を判断させない。

## 可観測性と運用

- ログ: Lambda は実行ごとに 1 行の JSON 要約(`scanned`、`created`、`enqueued`、`sent`、`skipped`、`expired`、`suppressed`、`failed`、`retried`、`discarded` の件数、所要時間)のみを出す。個人情報を含めない。
- メトリクス: 上記件数、queue の depth/oldest message age、DLQ 件数、Lambda の error/throttle、SES の send/bounce/complaint 率(SES 側)。
- アラート: DLQ が 1 件以上、notifications queue の oldest message age、Lambda の error 急増、SES の bounce/complaint 率(SES の reputation 指標)。アラームの通知先 SNS は T-501 で接続し、本タスクではトピックの器を作る。
- Runbook: `docs/runbooks/notification-delivery.md`(DLQ の確認と redrive、スケジューラ停止時の影響、suppression の確認と解除、署名鍵のローテーション)を作成する。
- 展開/ロールバック: スケジューラの EventBridge を無効化すれば新しい配送は作られない(停止方法)。Feature Flag は環境変数 `NOTIFICATION_DELIVERY_ENABLED`(既定 `false`)で、false のとき scheduler/delivery は何もしない。Migration は expand のみ。ロールバックはアプリの revert と EventBridge の無効化。
- 費用/capacity: SES 送信数、SQS/Lambda の実行回数はユーザー数 × 1 通/日が上限。走査は有効な設定の全件を 5 分ごとに読むため、規模が大きくなったら走査の絞り込み(timezone 別のシャーディング等)が必要(受容リスク)。

## テスト対応表

| 要件        | Unit                                                                                                                               | Integration(実 PostgreSQL / fake HTTP)                                                 | E2E                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------- |
| NDL-001     | `resolveReminderSlot`(通常/日付境界/DST gap/DST fall-back、プロパティテスト)、`scheduleDueRemindersUseCase`(枠内/枠外/重複/前日枠) | 走査のページング、dedupe の `ON CONFLICT`、並行スケジューラで 1 行、部分 index を使う  | N/A(E2E 基盤導入後) |
| NDL-002     | outbox(投入失敗→再投入、10 分未満は再投入しない)、message が `deliveryId` のみ                                                     | 再投入対象の選択、`enqueued_at` 更新                                                   | N/A                 |
| NDL-003     | `deliverReminderUseCase` の各判定順序(expired/disabled/suppressed/quiet hours/already_recorded/no_recipient/sent)                  | claim の並行 6 件で 1 回、終端行は不変、lease の期限切れ                               | N/A                 |
| NDL-004     | 失敗分類、backoff の上限・jitter 範囲(プロパティテスト)、5 回で failed、permanent は即 failed                                      | SES adapter を fake HTTP server で(200、429、5xx、4xx、timeout)、SQS の batch 部分失敗 | N/A                 |
| NDL-005     | 許容遅延の境界(59/60/61 分)                                                                                                        | 期限切れの記録                                                                         | N/A                 |
| NDL-006     | 本文に個人固有の内容がない(習慣名・表示名を含まない)、ヘッダーの付与                                                               | SES に渡るヘッダー(fake server で受信内容を確認)                                       | N/A                 |
| NDL-007     | token の生成・検証(往復、改ざん、用途違い、長さ、プロパティテスト)、`unsubscribeUseCase` の冪等、handler の 200/400/GET            | 設定の `enabled=false` 反映、他ユーザーに影響しない                                    | N/A                 |
| NDL-008     | 引き当て・Permanent/Complaint/Transient・未知 ID・不正イベント                                                                     | `email_suppressions` の冪等 INSERT、`provider_message_id` の一意                       | N/A                 |
| NDL-009     | N/A                                                                                                                                | `terraform fmt -check` / `terraform validate`(CI)。plan/policy は未実施                | N/A                 |
| NDL-INV-001 | -                                                                                                                                  | `deduplication_key` の UNIQUE                                                          | N/A                 |
| NDL-INV-002 | 終端への遷移拒否                                                                                                                   | `WHERE status='pending'` で更新されない                                                | N/A                 |
| NDL-INV-009 | suppression 優先                                                                                                                   | suppression 済みで有効な設定でも送られない                                             | N/A                 |
| DB 制約     | -                                                                                                                                  | CHECK(status、attempt_count、reason)、FK CASCADE、fresh と upgrade の Migration        | N/A                 |

Fake/Stub 方針: Application の unit test は in-memory fake、固定 Clock、乱数注入。SES/SQS adapter は fake HTTP server(endpoint 上書き)。Integration は Testcontainers の実 PostgreSQL。fixture は架空データのみ。テスト品質の 3 観点(プロパティベース、変異、敵対的審査)を実施して結果を完了報告に書く。

## 未決事項

実装をブロックしない事項:

- **許容遅延 60 分、lease 5 分、再投入 10 分、スケジューラ間隔 5 分、最大試行 5 回、backoff 上限 15 分**: 暫定値。運用実績で調整する(定数のみ)。
- **SES の送信ドメイン・region・sandbox 解除**: [ADR-005](../adr/ADR-005-email.md) の follow-up。コードは設定(`EMAIL_FROM`、region)で切り替え、検証は sandbox の verified address で行う。ドメイン確定まで本番送信はしない。
- **認証メールの SES 実装**: T-101 は本番で `AUTH_EMAIL_SENDER=smtp` を禁止しているため、本番公開前に認証メール用の SES adapter が必要。T-402 の SES adapter と設定(identity、configuration set)を再利用できるが、担当タスクが未割当（ロードマップへの追加を提案する）。
- **署名鍵のローテーション**: token に版数 `v1` を持つ。複数鍵の同時許容は鍵を替える必要が出たときに設計する。
- **アドレス単位の suppression**: email 変更・再登録が実装された時点で、ユーザー単位からアドレス(ハッシュ)単位への拡張を検討する。SES の account-level suppression list は Terraform で有効にして backstop とする。
- **配送行の保持期間・パージ**: 運用実績を見て決める(T-404 の削除フローには含まれる)。
- **走査の効率化**: 有効な設定の全件走査。ユーザー数が増えたら timezone 別の絞り込みを検討する。
- **Terraform の plan / policy-as-code / tflint**: 実行環境と AWS 認証情報がないため未実施。T-501 で CI に統合する。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-09
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                              |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | 目的、成功指標、範囲/対象外。`docs/02` UC-15、`docs/09` T-402、T-401 の受容リスク(配信停止経路)                                       |
| Specification        | Pass   | NDL-001〜009、NDL-INV-001〜009、状態遷移、受け入れ基準、失敗・境界ケース。未決事項は非ブロック(暫定値は定数のみ)                      |
| Domain and Time      | Pass   | NDL-INV-006(DST gap/fall-back、日付境界の 2 日候補)、冪等性(dedupe、claim、終端の不変)、at-least-once、重複送信の残存を明記           |
| API and Data         | Pass   | APIとイベント(unsubscribe、message、SES イベントの schema)、データとMigration(expand のみ、制約・index、fresh/upgrade 検証、rollback) |
| Security and Privacy | Pass   | セキュリティとプライバシー(token、IAM、最小露出、ログ禁止、suppression)、認可マトリクス                                               |
| AI                   | N/A    | AI を利用しない                                                                                                                       |
| Testing              | Pass   | テスト対応表(fake HTTP server、実 PostgreSQL、プロパティ/変異/敵対的審査)。E2E は基盤未導入のため N/A と理由を明記                    |
| Operations           | Pass   | 可観測性と運用(ログ、メトリクス、アラーム、Runbook、停止方法、Feature Flag、費用)                                                     |
| Planning             | Pass   | [../plans/notification-delivery.md](../plans/notification-delivery.md)                                                                |

### 受容リスク

- 送信成功後・記録前に worker が crash すると、メールが重複して送られうる(SES に冪等キーがない。頻度は低く、重複は 1 通のリマインドに留まる)。
- Rate limit 未実装。配信停止 endpoint は token の検証で保護し、入力長を制限する。
- 配信停止が、ワーカーが設定を確認した後・送信の前の短い間に行われた場合は、その 1 通は送られうる(確認と送信を同一 transaction にできないため)。次回以降は送られない。
- 同日に設定の timezone/時刻を変えた場合、既に作られた当日の配送は旧設定の枠のまま送られうる(送信前の再確認で disabled/quiet hours は反映される)。
- 走査が有効な設定の全件で、規模が大きくなると非効率になる(ベータ規模では許容)。
- 構造化ログ基盤が未導入のため、Lambda の運用ログは件数の要約 1 行に限る。
- Terraform は apply/plan/policy を検証していない(fmt/validate のみ)。実環境での適用は T-501 以降に別途レビューする。
- suppression がユーザー単位のため、アドレス変更後の旧アドレス宛のリスクは未対応(現状メール変更機能がない)。
