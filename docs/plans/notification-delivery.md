# 通知のスケジュールと配送 Implementation Plan

Status: Done
責任者: TBD
最終更新: 2026-10-09
Spec: [../specs/notification-delivery.md](../specs/notification-delivery.md)
変更区分: Standard

## 方針

T-401 と同じ層構成で、AWS 依存を adapter に閉じ込めて実装する。差分が大きいため、同じ Spec のもとで 2 本の PR に分けて届ける(それぞれ独立してレビュー・検証できる)。

- **PR-A(コア)**: Domain/Application/契約、Migration、Prisma adapter、配信停止 endpoint(署名付き token)。SES/SQS は port と fake のみで、AWS SDK を使わない。この時点でメール送信はどこにも接続されない。
- **PR-B(AWS 接続とインフラ)**: SES/SQS/Secrets の adapter(AWS SDK v3)、`apps/workers` の Lambda handler 3 本、Terraform(`infra/`)、Runbook、CI の Terraform 検査。

手順(PR-A):

1. **Migration**(`t402_notification_delivery`): `notification_deliveries` に列・CHECK・index を追加、`email_suppressions` を新設、走査用の部分 index を追加。`schema.prisma` を更新(部分 index・CHECK はコメントで Migration を指す)。
2. **Domain**(`packages/domain/src/notifications/`):
   - `resolveReminderSlot(localDate, localTime, timezone)`: ローカル日付 + 時刻 → UTC の `Date`。`Intl.DateTimeFormat` で offset を求め、gap は直後の最初の瞬間、fall-back は早い方を返す。
   - `reminder-delivery.ts`: `ReminderDeliveryStatus`、定数(許容遅延、最大試行、backoff 上限、lease、再投入間隔)、`calculateRetryDelayMs(attempt, random)`、`isExpired(scheduledAt, now)`、`isTerminal(status)`、`reminderDeduplicationKey(settingId, localDate)`。
3. **Application**(`packages/application/src/notifications/`):
   - port: `ReminderDeliveryRepositoryPort`(`listEnabledSettings`、`createPendingIfAbsent`、`listEnqueueCandidates`、`markEnqueued`、`claim`、`complete`(終端化)、`scheduleRetry`、`findByProviderMessageId`)、`ReminderQueuePort`、`ReminderEmailPort`(`transient`/`permanent` を分類した `ReminderEmailError`)、`UnsubscribeTokenPort`、`EmailSuppressionPort`、`RecipientPort`(送信直前の宛先取得)。
   - use case: `scheduleDueRemindersUseCase`、`deliverReminderUseCase`、`handleEmailFeedbackUseCase`、`unsubscribeUseCase`(設定の `disable` を使う。`NotificationSettingsRepositoryPort` に `disable` と `findEnabledForDelivery` を追加)。
   - `buildReminderEmail`(定型の件名・本文・ヘッダー)。fake も併設。
4. **Infrastructure**(`packages/infrastructure/src/notifications/`): `PrismaReminderDeliveryRepository`、`PrismaEmailSuppressionRepository`、`PrismaRecipientRepository`、`HmacUnsubscribeTokenSigner`(`node:crypto`)。
5. **Contracts**(`packages/contracts/src/notification-delivery.ts`): 配信停止 query、queue message(`version: 1`)、SES feedback イベントの runtime schema。
6. **Presentation**(`apps/web`): `notification-unsubscribe-handlers.ts`、container、`app/api/v1/notification-unsubscribe/route.ts`(GET/POST)。`packages/config` に `UNSUBSCRIBE_SIGNING_KEY` を追加。
7. **文書**: `docs/04`(補足)、`docs/05`(契約)、`docs/09`、`docs/10`(暫定値)、`docs/specs/auth-adapter.md`(SES は T-402)。

手順(PR-B):

8. **AWS adapter**(`packages/infrastructure/src/{email,queue,secrets}/`): `SesReminderEmailSender`(`@aws-sdk/client-sesv2`、timeout/abort、エラー分類)、`SqsReminderQueue`(`@aws-sdk/client-sqs`)、Secrets Manager 読み込み。AWS SDK の型は adapter の外へ出さない。
9. **Lambda handler**(`apps/workers/src/handlers/`): `reminder-scheduler`、`reminder-delivery`(SQS batch、`batchItemFailures`)、`ses-feedback`(SNS 包みの SES イベント)。composition root は handler の外側の module にまとめ、handler は薄く保つ。`NOTIFICATION_DELIVERY_ENABLED` フラグ。
10. **Terraform**(`infra/modules/email`、`infra/modules/queue-worker`、`infra/environments/dev`): provider/version を pin、lockfile を commit、backend は partial 設定、default tags。Secret は器のみ。
11. **Runbook**(`docs/runbooks/notification-delivery.md`)、CI に `terraform fmt -check` と `terraform validate` の job、ADR(通知配送の非同期方式)を追加。

## 影響分析

| 領域           | 変更                                                                                                 | リスク                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Domain         | `notifications/` に時刻変換・状態・定数を追加                                                        | 中(DST の時刻変換。プロパティテストで検証)                   |
| Application    | `notifications/` に use case・port・fake を追加。`NotificationSettingsRepositoryPort` にメソッド追加 | 中(判定順序と冪等性。Unit で網羅)                            |
| Infrastructure | Prisma repository、HMAC token、SES/SQS/Secrets adapter を追加。AWS SDK を依存に追加                  | 中〜高(外部境界。fake HTTP server で timeout/429/5xx を検証) |
| Presentation   | 公開 endpoint 1 本(GET/POST)。Lambda handler 3 本                                                    | 中(公開 endpoint。token の検証で保護)                        |
| Database       | Migration 1 本(列・CHECK・index・新テーブル。expand のみ)                                            | 低〜中(既存行なし前提。fresh/upgrade を検証)                 |
| API/Event      | 配信停止 endpoint、queue message、SES イベント schema                                                | 中                                                           |
| AWS/Terraform  | `infra/` を新設(apply しない)                                                                        | 中(実環境未検証。fmt/validate のみ)                          |
| Observability  | Lambda の要約ログ、DLQ アラーム、Runbook                                                             | 低                                                           |

## インターフェースと契約

- Domain: `resolveReminderSlot`、`calculateRetryDelayMs`、`isExpired`、`reminderDeduplicationKey`、定数(`REMINDER_MAX_LATENESS_MINUTES` 他)、型 `ReminderDeliveryStatus`。
- Application: Spec の「APIとイベント」の port 群。`ReminderEmailPort.send({ to, subject, text, unsubscribeUrl })` は成功時に `{ providerMessageId }` を返し、失敗は `ReminderEmailError`(`kind: "transient" | "permanent"`、`code`)を投げる。メッセージにアドレスを含めない。
- Contracts / HTTP / Queue / SES イベント: Spec の「APIとイベント」のとおり。

## データMigration

- Expand: 列追加(NOT NULL は既存行なし前提)、CHECK、index、`email_suppressions` 新設、走査用の部分 index。
- Backfill: N/A(既存行なし)。
- Switch: N/A(アプリが初めてこのテーブルに書く。`NOTIFICATION_DELIVERY_ENABLED = false` で開始)。
- Contract: N/A。
- ロールバック/前方修正: アプリの revert と EventBridge の無効化。制約が問題なら forward Migration で外す。
- 検証: fresh と upgrade の両方を Integration Test で確認する(T-401 と同じ方法)。

## セキュリティレビュー

- 認証/認可: 公開 endpoint は token のみで保護(用途・署名・定数時間比較)。Lambda は IAM。Member 向けの配送参照 API は作らない。
- 個人情報/Secret/ログ: email は送信直前にのみ取得しログ・message・配送行に残さない。署名鍵は Secrets Manager の器のみ(値は state に入れない)。Lambda のログは件数のみ。fixture は架空データ(`example.com`/`example.test`)のみ。
- 悪用対策: token 検証前に DB へ触れない、入力長の上限、GET は状態不変、opt-in の毎回再確認、suppression 優先、queue message の最小化と schema 検証。

## テスト計画

| 要件        | テスト種別  | 予定テスト                                                                                                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NDL-001/006 | Unit        | `reminder-slot.test.ts`(通常/日付境界/gap/fall-back)と `reminder-slot.property.test.ts`(任意の timezone・時刻で、結果の現地時刻が入力と一致するか gap の直後) |
| NDL-004/005 | Unit        | `reminder-delivery.test.ts`(backoff の上限・jitter 範囲のプロパティ、許容遅延の境界 59/60/61 分、終端判定)                                                    |
| NDL-001/002 | Unit        | `schedule-due-reminders.test.ts`(枠内/枠外/前日枠/重複/再投入/投入失敗)                                                                                       |
| NDL-003/004 | Unit        | `deliver-reminder.test.ts`(判定順序の全分岐、transient→retry、5 回で failed、permanent、終端は no-op)                                                         |
| NDL-006     | Unit        | `reminder-email.test.ts`(個人固有の内容を含まない、ヘッダー)                                                                                                  |
| NDL-007     | Unit        | `unsubscribe-token.test.ts`(往復、改ざん、用途違い、切り詰め、プロパティ)、`unsubscribe.test.ts`(冪等)、handler の 200/400/GET                                |
| NDL-008     | Unit        | `email-feedback.test.ts`(Permanent/Complaint/Transient/未知 ID/不正イベント)                                                                                  |
| NDL-001〜   | Integration | `prisma-reminder-delivery-repository.integration.test.ts`(dedupe、並行 claim 6 件で 1 回、lease 切れ、再投入の選択、終端不変、CHECK、CASCADE)                 |
| NDL-008     | Integration | `prisma-email-suppression-repository.integration.test.ts`(冪等 INSERT、`provider_message_id` の一意)                                                          |
| NDL-007     | Integration | 配信停止が設定の `enabled=false` に反映され、他ユーザーに影響しない                                                                                           |
| Migration   | Integration | fresh と upgrade の両方                                                                                                                                       |
| NDL-004(B)  | Integration | SES/SQS adapter を fake HTTP server で(200、429、5xx、4xx、timeout、ヘッダー)                                                                                 |
| NDL-009(B)  | CI          | `terraform fmt -check -recursive`、`terraform validate`                                                                                                       |

テスト品質の 3 観点: (1) プロパティベース(スロット変換、backoff、token)、(2) 変異テスト(Stryker は未導入。判定順序・境界・分類を手動で壊して検知を確認)、(3) 敵対的審査(重複送信・競合・改ざん・DST を攻撃者の視点で見直し、結果を報告)。

## 展開と運用

- Feature Flag: `NOTIFICATION_DELIVERY_ENABLED`(既定 `false`)。false のとき scheduler と delivery は何もしない。
- デプロイ順序: Migration → アプリ(unsubscribe endpoint) → インフラ(dev) → フラグを有効化。SES の送信ドメイン確定前は sandbox の verified address のみで検証する。
- メトリクス/アラーム: Spec の「可観測性と運用」。DLQ > 0 と oldest message age は必須。
- ロールバック条件と手順: 重複送信・誤送信・DLQ の増加時に EventBridge を無効化し、フラグを false にする。アプリは revert。

## タスク分解

PR-A:

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Migration + fresh/upgrade の検証
3. Domain: `resolveReminderSlot`、配送の定数・判定 + Unit/プロパティテスト
4. Application: port、use case、本文、fake + Unit Test
5. Infrastructure: Prisma repository、HMAC token + Integration/Unit Test
6. Contracts: schema + Unit Test
7. Presentation: 配信停止 endpoint + Unit Test
8. 文書更新、品質コマンド一式、3 観点の検証、セルフレビュー、PR-A

PR-B:

9. AWS adapter(SES、SQS、Secrets)+ fake HTTP server テスト
10. Lambda handler 3 本 + Unit Test
11. Terraform(email、queue-worker、dev)+ fmt/validate
12. Runbook、ADR、CI の Terraform job、品質コマンド一式、セルフレビュー、PR-B

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行 task: T-401(設定と `isWithinQuietHours`、PR #19 で main 済み)、T-202(記録)、T-102(timezone)。
- ADR 依存: [ADR-005](../adr/ADR-005-email.md)(送信ドメインは未確定。本タスクは sandbox 前提で、ドメイン確定を実本番送信の条件とする)。
- 外部アカウント/権限: AWS アカウントと認証情報は本タスクでは使わない(apply しない)。`terraform init` に provider のダウンロードが必要。

## リスク

| リスク                                   | 対策                                                                                  | 責任者 |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| DST の時刻変換の誤り                     | 独立した検証(現地時刻の再計算)によるプロパティテスト、gap/fall-back の具体例          | TBD    |
| 重複送信(crash のタイミング、並行 claim) | claim の単一 `UPDATE`、終端の不変、lease。残る重複は受容リスクとして明記              | TBD    |
| AWS SDK の型・エラーが port へ漏れる     | adapter の内側で分類して `ReminderEmailError` に変換。`lint:boundaries` で検知        | TBD    |
| fake HTTP server と実 AWS の挙動差       | エラー分類をステータス/エラー名の表に集約し、実環境(sandbox)での確認を Runbook に残す | TBD    |
| Terraform が実環境で通らない(未 apply)   | fmt/validate のみ実施し受容リストに明記。T-501 で plan/policy を追加                  | TBD    |
| 差分が大きい                             | PR-A/PR-B に分割し、各 PR で品質コマンド一式を実行                                    | TBD    |

## 着手条件

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(ADR-005。送信ドメインは follow-up で本タスクをブロックしない)
- [x] API/event契約がレビュー済み(Spec の APIとイベント)
- [x] Migration方針がレビュー済み(Spec のデータとMigration)
- [x] 認可・データ保護方針がレビュー済み(セキュリティとプライバシー)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、fake HTTP server)
- [x] 依存taskが完了している(T-401 は main に merge 済み)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
