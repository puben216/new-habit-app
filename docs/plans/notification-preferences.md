# Notification Preferences Implementation Plan

Status: Done
Owner: TBD
Last updated: 2026-10-04
Spec: [../specs/notification-preferences.md](../specs/notification-preferences.md)
Change classification: Standard

## Approach

T-203 と同じ層構成で縦に薄く実装する。新しい module `notifications` を Domain/Application/Infrastructure に作る。DB は expand のみの Migration 1 本。

1. **Migration**(`packages/infrastructure/database/migrations/<timestamp>_t401_notification_settings_constraints/`): 部分 unique index `notification_settings_user_default_uidx (user_id) WHERE habit_id IS NULL`、CHECK(`channel`、quiet hours の整合、`timezone` 長)。`schema.prisma` には部分 index を表現できないため、コメントで Migration 側の制約を明記する。
2. **Domain**(`packages/domain/src/notifications/`):
   - `resolveNotificationPreference(input)`: `HH:mm` 検証、`parseTimezone`(T-102)による timezone 検証、quiet hours 検証(start≠end)、`enabled: true` 時の「送信時刻が quiet hours 内」拒否。既定値の定数(`DEFAULT_REMINDER_LOCAL_TIME`、`DEFAULT_QUIET_HOURS`)。
   - `isWithinQuietHours(localTime, quietHours)`: `[start, end)`、日跨ぎ対応の純粋関数(T-402 が再利用)。
   - エラー: `InvalidNotificationPreferenceError`(`field` を持つ)、`ReminderTimeInQuietHoursError`。
3. **Application**(`packages/application/src/notifications/`): `NotificationSettingsRepositoryPort`(`find`、`upsert`)、`getNotificationSettingsUseCase`(未保存は既定値)、`upsertNotificationSettingsUseCase`(timezone 既定値にプロフィールを使用)、`UserNotFoundError`。fake を併設。
4. **Infrastructure**(`packages/infrastructure/src/notifications/`): `PrismaNotificationSettingsRepository`。`time` 列は `to_char(..., 'HH24:MI')` で文字列として読み、書き込みは `${value}::time`。upsert は `INSERT ... SELECT ... FROM users ... ON CONFLICT (user_id) WHERE habit_id IS NULL DO UPDATE ... RETURNING` の単一文(`$queryRaw` のタグ付きテンプレート)。
5. **Contracts**(`packages/contracts/src/notification-settings.ts`): `upsertNotificationSettingsRequestSchema`(`.strict()`、`HH:mm` の regex)、`notificationSettingsResponseSchema`。
6. **Presentation**(`apps/web`): `notification-settings-handlers.ts`(`habit-http.ts` の共通処理を再利用)、`notification-settings-container.ts`、`app/api/v1/notification-settings/route.ts`(GET/PUT)。
7. **文書**: `docs/04`(実装時の補足)、`docs/05`(契約差分)、`docs/09`、`docs/10`(P2 の暫定 quiet hours)、`docs/specs/habit-api.md`/`user-profile.md` の T-401 参照の整合。

## Impact Analysis

| Area           | Change                                                    | Risk                                                                 |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| Domain         | `notifications/` に関数・定数・エラーを追加               | 低                                                                   |
| Application    | `notifications/` に use case・port・error・fake を追加    | 低                                                                   |
| Infrastructure | `notifications/` に Prisma repository を追加              | 中(部分 index に対する ON CONFLICT と `time` 列。Integration で検証) |
| Presentation   | 新規 route 1 件(2 メソッド)と handler                     | 低                                                                   |
| Database       | Migration 1 本(unique index と CHECK の追加。expand のみ) | 低〜中(既存行があると失敗。既存行なし前提を Spec に明記)             |
| API/Event      | 新規 endpoint 2 件(同一 path)                             | 低                                                                   |
| AWS/Terraform  | 変更なし                                                  | N/A                                                                  |
| Observability  | 変更なし                                                  | N/A                                                                  |

## Interfaces and Contracts

- Domain: `resolveNotificationPreference`、`isWithinQuietHours`、型 `NotificationPreferenceInput`/`ResolvedNotificationPreference`/`QuietHours`、定数 `DEFAULT_REMINDER_LOCAL_TIME`/`DEFAULT_QUIET_HOURS`、エラー `InvalidNotificationPreferenceError`/`ReminderTimeInQuietHoursError`。
- Application:
  - `NotificationSettingsRepositoryPort`: `find({ actorUserId }): Promise<NotificationSettingsRecord | null>`、`upsert({ actorUserId, enabled, localTime, timezone, quietHours, now }): Promise<NotificationSettingsRecord | null>`(user が存在しなければ `null`)。
  - `NotificationSettingsRecord { enabled, localTime, timezone, quietHours, updatedAt }`。
  - `NotificationSettingsView`: `NotificationSettingsRecord` と同形で `updatedAt: Date | null`(未保存の既定値)。
  - use case: `getNotificationSettingsUseCase(deps, { actorUserId })`、`upsertNotificationSettingsUseCase(deps, { actorUserId, enabled, localTime, quietHours?, timezone? })`。
- Contracts / HTTP: Spec の API and Events 節のとおり。

## Data Migration

- Expand: 部分 unique index と CHECK を追加(後方互換。既存コードはこの表を読み書きしていない)。
- Backfill/Switch/Contract: N/A(既存行なし、スキーマの置換なし)。
- 検証: Integration Test で fresh database(全 Migration 適用)と upgrade(直前の Migration まで適用した状態に、本 Migration を適用)の両方を確認する。
- Rollback/forward fix: アプリの revert。制約を外す場合は DROP する forward Migration を追加する(適用済み Migration は編集しない)。

## Security Review

- Authentication/authorization: session から actor を取得し、repository の全 query に actor user ID を渡す。path/body に user を含めない(未知キーは 422)。
- PII/secrets/logging: 設定値・body をログに出さない。route に独自ログを追加しない。email を扱わない。fixture は架空データのみ。
- Abuse controls: body 16 KiB、固定形式の項目。Rate limit は Accepted Risk。
- SQL: raw SQL はタグ付きテンプレートのバインド変数のみ。
- opt-in: 既定は無効。有効化はユーザーの明示的な `enabled: true` のみ。

## Test Plan

| Requirement | Test level  | Planned test                                                                                                                                                     |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NPF-003     | Unit        | `notification-preference.test.ts`: `HH:mm` 境界(00:00/23:59/24:00/7:30/秒付き)、timezone、start=end、quiet hours 内の時刻(enabled true/false)、日跨ぎ            |
| NPF-INV-006 | Unit        | `isWithinQuietHours`: 22:00/06:59/00:00/07:00/21:59、日跨ぎなし(01:00〜05:00)                                                                                    |
| NPF-001/002 | Unit        | `notification-settings.test.ts`: 未保存の既定値、プロフィール timezone の適用、作成/置換/再送、quietHours の省略(既定)と null、user 不存在、actor が repo に渡る |
| NPF-004     | Unit        | `enabled: false` で保存され localTime が保持される、無効時は quiet hours 内の時刻でも保存可                                                                      |
| 契約        | Unit        | `contracts/notification-settings.test.ts`: 未知キー(userId/habitId/channel)、`HH:mm` 形式、quietHours の形、enabled 型                                           |
| HTTP        | Unit        | `notification-settings-handlers.test.ts`: 401/403/404/413/415/422 のマッピング、reminder_time_in_quiet_hours、body の user 指定拒否                              |
| NPF-001/002 | Integration | `prisma-notification-settings-repository.integration.test.ts`: 未保存で行が作られない、upsert 往復、置換、再送、並行 6 件で 1 行、`time` 列の往復                |
| NPF-INV-001 | Integration | 他ユーザーの設定と混ざらない、user 不存在で `null`                                                                                                               |
| NPF-INV-002 | Integration | `habit_id` 付きの行は別枠(部分 index の対象外)、ユーザー単位の重複 INSERT が一意制約で拒否される                                                                 |
| DB 制約     | Integration | channel、quiet hours 片方 NULL、start=end、timezone 長の CHECK、fresh と upgrade の Migration                                                                    |

## Rollout and Operations

- Feature Flag: 不要(新規 route のみ。メールは送信されない)。
- Deployment order: Migration を先に適用し、その後にアプリをデプロイする(アプリが先でも既存コードに影響しない)。
- Metrics/alarms: 追加なし。
- Rollback trigger and procedure: 不具合時はアプリを revert する。制約が問題なら forward Migration で外す。
- T-402 への引き継ぎ: メール送信前にワンクリック unsubscribe を実装すること(T-402 の Start Condition)。

## Task Breakdown

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Migration + fresh/upgrade の検証
3. Domain: `resolveNotificationPreference`/`isWithinQuietHours` + Unit Test
4. Application: port、use case、error、fake + Unit Test
5. Infrastructure: `PrismaNotificationSettingsRepository` + Integration Test
6. Contracts: schema + Unit Test
7. Presentation: handler、container、route + Unit Test
8. 文書更新(`docs/04`、`05`、`09`、`10`)
9. 品質コマンド一式(`test:integration` を含む)の実行、セルフレビュー

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## Dependencies

- 先行 task: T-004(テーブル)、T-101(session)、T-102(プロフィール・`parseTimezone`)。いずれも main に取り込み済み。
- ADR 依存: [ADR-005](../adr/ADR-005-email.md)(本タスクはメールを送らないためブロックされない)。外部権限、provider: なし。

## Risks

| Risk                                                      | Mitigation                                                 | Owner |
| --------------------------------------------------------- | ---------------------------------------------------------- | ----- |
| 部分 unique index に対する `ON CONFLICT` の推論が失敗する | Integration Test で実 PostgreSQL に対して検証する          | TBD   |
| `time` 列の Prisma 変換で時刻がずれる                     | 文字列(`HH24:MI`)で読み書きし、Date 変換を介さない         | TBD   |
| 暫定既定値(20:00、22:00〜07:00)が P2 確定で変わる         | Domain の定数のみに置き、DB には焼き込まない               | TBD   |
| 配信停止の経路が不足したままメール送信が始まる            | T-402 の Start Condition にワンクリック unsubscribe を明記 | TBD   |

## Start Conditions

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(ADR-005 は本タスクの対象外)
- [x] API/event契約がレビュー済み、またはN/A(Spec の API and Events 節)
- [x] Migration方針がレビュー済み(Spec の Data and Migration 節)
- [x] 認可・データ保護方針がレビュー済み(Security and Privacy 節)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、既存 fake)
- [x] 依存taskが完了している(T-004/T-101/T-102)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
