# Habit Entry Implementation Plan

Status: Done
Owner: TBD
Last updated: 2026-10-03
Spec: [../specs/habit-entry.md](../specs/habit-entry.md)
Change classification: Standard

## Approach

T-104 と同じ層構成・パターンで、縦に薄く実装する。

1. **Domain**(`packages/domain/src/tracking/`): `resolveHabitEntry(kind, targetCount, input)` を純粋関数として追加する。成功判定は既存の `isTargetMet` と同じ式を使い、`status`/`quantity` の矛盾を作れないようにする。エラーは `InvalidHabitEntryError`(`HabitDomainError` を継承し、Presentation の既存 fallback に乗る)。tracking は habits を import してよい(逆は不可)。
2. **Application**(`packages/application/src/tracking/`): `HabitEntryRepositoryPort`、`getTodaySchedule`、`upsertHabitEntry`、Application error(`EntryDateOutOfRangeError`、`HabitNotScheduledError`)、定数 `ENTRY_BACKDATE_LIMIT_DAYS = 7`。「今日」は `localDateAt(now(), profile.timezone)` で 1 回だけ求める。habits は既存の `HabitRepositoryPort`、timezone は既存の `ProfileRepositoryPort.ensure`(遅延作成)を使う。
3. **Infrastructure**(`packages/infrastructure/src/tracking/`): `PrismaHabitEntryRepository`。upsert は 1 文の `INSERT ... ON CONFLICT (habit_id, habit_date) DO UPDATE ... RETURNING`(`$queryRaw` のタグ付きテンプレート)で、`habit_id` は `habits` を `public_id` と `user_id` で解決するサブクエリから得る(IDOR を query 条件で防ぐ)。日付別一覧は `habit_entries` と `habits` の join(`user_id`、`habit_date`)。
4. **DB**: Migration を 1 件追加する(`quantity` の CHECK)。`schema.prisma` は変更しない(CHECK は Prisma 管理外、既存の CHECK と同じ扱い)。
5. **Contracts**(`packages/contracts/src/tracking.ts`): `upsertHabitEntryRequestSchema`、`habitEntryDateSchema`(path)、`habitEntryResponseSchema`、`todayScheduleResponseSchema`。
6. **Presentation**(`apps/web`): `entry-handlers.ts`(`habit-http.ts` の `readJsonBody`/`isTrustedOrigin`/`problemResponse` を再利用)、`entry-container.ts`、`app/api/v1/schedule/today/route.ts`、`app/api/v1/habits/[habitId]/entries/[date]/route.ts`。
7. **文書**: `docs/04`、`docs/05`、`docs/10`(P2 の note 保留と、reduce の意味論の決定を追記)、`docs/09`(roadmap)、habit-domain/habit-api Spec の Open Question に解決先を追記。

## Impact Analysis

| Area           | Change                                                                    | Risk                                                        |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Domain         | `tracking/` を追加(`resolveHabitEntry`、エラー)。既存 habits は変更しない | 低                                                          |
| Application    | `tracking/` を追加(2 use case、port、error)。既存 use case は変更しない   | 低                                                          |
| Infrastructure | `tracking/` を追加(Prisma repository)                                     | 中(raw SQL の upsert。Integration Test で並行・IDOR を検証) |
| Presentation   | 新規 route 2 件と handler。既存 handler は変更しない                      | 低                                                          |
| Database       | Migration 1 件(CHECK 追加)                                                | 低(既存行なし。ロックは空テーブル相当)                      |
| API/Event      | 新規 endpoint 2 件。既存契約の変更なし                                    | 低                                                          |
| AWS/Terraform  | 変更なし                                                                  | N/A                                                         |
| Observability  | 変更なし(ログ方針は Spec のとおり)                                        | N/A                                                         |

## Interfaces and Contracts

- Domain(`@habit-app/domain`): `resolveHabitEntry`、型 `HabitEntryStatus`、`HabitEntryInput`、`ResolvedHabitEntry`、`HABIT_ENTRY_STATUSES`、`HABIT_ENTRY_MAX_QUANTITY`、エラー `InvalidHabitEntryError`。
- Application(`@habit-app/application`):
  - `HabitEntryRepositoryPort`: `upsert({ actorUserId, habitId, date, status, quantity, now }): Promise<HabitEntryRecord | null>`(習慣が actor のものとして存在しなければ `null`)、`listByDate({ actorUserId, date }): Promise<readonly HabitEntryRecord[]>`。
  - `HabitEntryRecord { habitId, date, status, quantity, createdAt, updatedAt }`(`habitId` は習慣の外部 ID)。
  - use case: `getTodaySchedule(deps, { actorUserId })`、`upsertHabitEntry(deps, { actorUserId, habitId, date, status, quantity })`。
  - error: `EntryDateOutOfRangeError`、`HabitNotScheduledError`。既存の `HabitNotFoundError`、Domain の `HabitArchivedError` を再利用する。
- Contracts: zod schema(上記)。request は `.strict()`。
- HTTP: Spec の API and Events 節のとおり。

## Data Migration

- Expand: `habit_entries_quantity_check CHECK (quantity IS NULL OR (quantity >= 0 AND quantity <= 1000))` を追加する(新しい Migration ファイル。適用済み Migration は編集しない)。
- Backfill: 不要(T-202 以前にアプリが `habit_entries` へ書き込んでおらず既存行がない)。
- Switch/Contract: N/A(後方互換な追加のみ)。
- Rollback/forward fix: 制約が問題になった場合は drop する Migration を追加する(forward fix)。アプリの revert のみで機能は無効化できる。
- 検証: 既存の migration 統合テストの方法で fresh DB と既存スキーマからのアップグレードの両方を確認する。

## Security Review

- Authentication/authorization: session から actor を取得し、repository の全 query に actor user ID を渡す。習慣の解決は `public_id` と `user_id` の両条件。他人の習慣は 404。
- PII/secrets/logging: 記録の内容・body・session はログに出さない。route に独自ログを追加しない。fixture は架空データのみ。
- Abuse controls: `quantity` ≤ 1000、対象日の範囲、body 16 KiB。Rate limit は Accepted Risk。
- SQL: raw SQL は `Prisma.sql`/タグ付きテンプレートのバインド変数のみ。文字列連結をしない。

## Test Plan

| Requirement  | Test level  | Planned test                                                                                                                                                      |
| ------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HENT-003     | Unit        | `resolve-habit-entry.test.ts`: build/reduce × status × quantity の境界値(省略時の既定値、targetCount ちょうど/未満、0、1000/1001、負数、小数、reduce の quantity) |
| HENT-001     | Unit        | `get-today-schedule.test.ts`: ローカル日(Asia/Tokyo の日付繰り上がり、America/New_York の DST 日)、非予定日、archived 除外、記録の結合、並び順、空                |
| HENT-002/004 | Unit        | `upsert-habit-entry.test.ts`: 作成/訂正/再送、範囲境界(今日・7 日前・8 日前・未来)、非予定日、archived、不存在、actor が repo に渡る                              |
| 契約         | Unit        | `contracts/tracking.test.ts`: 未知キー、型違反、日付形式、quantity の範囲                                                                                         |
| HTTP         | Unit        | `entry-handlers.test.ts`: 401/403/404/409/413/415/422 のマッピング、404 と UUID 不正の同一視                                                                      |
| HENT-001/002 | Integration | `prisma-habit-entry-repository.integration.test.ts`: upsert 往復(作成→更新)、同一内容の再送、並行 2 件で 1 レコード、日付別一覧、各 status                        |
| HENT-INV-001 | Integration | 他ユーザーの習慣への upsert が `null` で何も書かない、`listByDate` に他ユーザーの記録が含まれない                                                                 |
| Migration/DB | Integration | `quantity` の CHECK(負数・1001 を拒否)、一意制約。fresh/upgrade の migration 検証                                                                                 |

property test: 追加しない(入力空間が小さく境界値の網羅で足りる)。

## Rollout and Operations

- Feature Flag: 不要(新規 route のみ)。
- Deployment order: Migration を先に適用、次にアプリ(古いアプリは新 route を持たず互換)。
- Metrics/alarms: 追加なし。
- Rollback trigger and procedure: 新 route で不具合が出た場合はアプリを revert する。Migration の CHECK は無害なため残してよい。必要なら drop の Migration を追加する。

## Task Breakdown

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Domain: `resolveHabitEntry` + Unit Test
3. Migration + Integration Test の制約検証
4. Application: port、use case、error、fake + Unit Test
5. Infrastructure: `PrismaHabitEntryRepository` + Integration Test(並行・IDOR)
6. Contracts: schema + Unit Test
7. Presentation: handler、container、route + Unit Test
8. 文書更新(`docs/04`、`05`、`10`、`09`、関連 Spec の Open Question)
9. 品質コマンド一式の実行、セルフレビュー、PR 作成

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## Dependencies

- 先行 task: T-101(session)、T-102(timezone)、T-103/T-104(Habit)、T-201(予定機会計算。PR #12。本ブランチは T-201 のブランチを起点にするため、PR #12 の merge 後に main へ rebase する)。
- ADR 依存、外部権限、provider: なし。

## Risks

| Risk                                                            | Mitigation                                                                                | Owner |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- |
| raw SQL の upsert で型変換(bigint/numeric/date)を誤る           | Integration Test(実 PostgreSQL)で往復と並行を検証。戻り値は明示的に変換・検証する         | TBD   |
| PR #12(T-201)の merge 前に本 PR を出すと差分に T-201 が含まれる | 本 PR の base を `feat/t-201-schedule-calculation` にするか、#12 の merge を待つ          | TBD   |
| 「今日」の判定が DST/日付境界でずれる                           | T-201 の関数を使用し、use case では `now()` を 1 回だけ呼ぶ。DST 日と日付境界の Unit Test | TBD   |
| 後勝ち upsert による別端末の記録の上書き                        | Accepted Risk として Spec に記載。必要になれば `If-Match` 等を別タスクで追加              | TBD   |

## Start Conditions

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(該当ADRなし)
- [x] API/event契約がレビュー済み、またはN/A(Spec の API and Events 節)
- [x] Migration方針がレビュー済み、またはN/A(expand のみ、forward fix)
- [x] 認可・データ保護方針がレビュー済み(Security and Privacy 節)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、既存 fake)
- [x] 依存taskが完了している(T-201 は PR #12 で review 待ちだがコードは本ブランチに含まれる。PR #12 の merge 後に main へ rebase する)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
