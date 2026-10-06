# Habit Repository, Use Cases and API Implementation Plan

Status: Done
責任者: TBD
最終更新: 2026-10-02
Spec: [../specs/habit-api.md](../specs/habit-api.md)
変更区分: Standard(新しい公開 API、認可、永続化を追加するため。[change-classification.md](../governance/change-classification.md) の判定表で「API/DB/auth を変えるか」に該当)

## 方針

T-103 の Domain(`Habit`、`createHabit`/`updateHabitDetails`/`archiveHabit`/`changeSchedule`)を業務ルールの唯一の定義として使い、その外側に薄い層を追加する。

- **Domain(追加のみ)**: DB 行から `Habit` を復元する `reconstituteHabit` を追加する。既存の `createScheduleVersion`/`assertNoOverlappingScheduleVersions` 等を再利用して不変条件を再検証するだけで、新しい業務ルールは持たない。
- **Application**: use case が「読み込み → Domain 操作 → 保存」を調停する。`HabitRepositoryPort`(`create`/`findById`/`list`/`save`)と `IdGeneratorPort`、`Clock`(既存の auth の型を再利用)に依存する。すべての port メソッドが `actorUserId` を必須引数に取り、所有者限定を型で強制する。楽観ロックは `save` が `expectedVersion` を受け取り、原子的に判定する。Application error(`HabitNotFoundError`/`HabitVersionConflictError`/`InvalidCursorError`)を定義し、Domain error はそのまま伝播させる。
- **Infrastructure**: `PrismaHabitRepository`。`save` は 1 transaction 内で「habit 行の条件付き `updateMany`(`WHERE id AND version`)→ `habit_schedule_versions` の差分反映(既存行の `effectiveTo` 更新を先、新規行の insert を後。exclusion constraint を満たす順序)」を行う。list は `(user_id, status)` 条件 + `(created_at, id)` の keyset で `limit+1` 件取得する。cursor は「直前の最終習慣の外部 ID と status」だけを持ち、repository が actor 条件付きで該当行の `(created_at, id)` を引いて keyset 位置にする(内部 ID を cursor に出さない)。`created_at` は Clock 由来のミリ秒精度で書き込み、Prisma の `Date` と DB の丸めずれによる keyset の欠落/重複を避ける。
- **Contracts**: zod の strict schema(request/query/response)を `packages/contracts/src/habits.ts` に追加する。上限値は定数として 1 か所に集約する。
- **Presentation(`apps/web`)**: route handler は `createHabitHandlers(deps)` が返す関数へ委譲するだけの薄い adapter にする。handler は依存(actor 解決、use case、許可 origin)を注入できるため、実 DB や Auth.js なしで HTTP 契約(401/403/404/409/413/415/422)を Unit Test できる。実 DB への接続・actor 解決(`auth()`)は composition root(`habit-container.ts`)に閉じ込める。
- **共有ファイルへの影響を最小化する**: 既存ファイルへの変更は、追加のみ(export の追加、`auth-container.ts` への `auth` 関数の公開)に限定する。

## 影響分析

| 領域           | 変更                                                                                                                  | リスク                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Domain         | `habit.ts` に `reconstituteHabit` を追加、`habits/index.ts` から export                                               | 低(既存関数は不変)                                    |
| Application    | `src/habits/*` を新規追加、`src/index.ts` に `export * from "./habits"` を追加                                        | 低                                                    |
| Infrastructure | `src/habits/*` を新規追加、`src/index.ts` に `export * from "./habits"` を追加                                        | 低                                                    |
| Contracts      | `src/habits.ts` を新規追加、`src/index.ts` に export を追加                                                           | 低                                                    |
| Presentation   | `apps/web/src/app/api/v1/habits/**` と `src/server/habit-*.ts` を新規追加、`auth-container.ts` に `auth` を追加で公開 | 中(`auth-container.ts` は T-102 `/me` と衝突しやすい) |
| Database       | 変更なし(既存 index/制約の利用を確認)                                                                                 | 低                                                    |
| API/Event      | `/api/v1/habits` 系 5 endpoint を追加。Event なし                                                                     | 低                                                    |
| AWS/Terraform  | 変更なし                                                                                                              | N/A                                                   |
| Observability  | 追加なし(Spec 参照)                                                                                                   | 低                                                    |
| Docs           | `docs/04`(実装時の補足 T-104)、`docs/05`(契約差分)、`docs/09`(T-104 記録)、`docs/10`(P2 暫定値)を追記                 | 低                                                    |

## インターフェースと契約

Application(`@habit-app/application` から export):

- 型: `HabitRecord { habit, version, createdAt, updatedAt }`、`HabitListStatus = "active" | "archived"`、`HabitRepositoryPort`、`IdGeneratorPort`、各 use case の `Deps`/`Input`、`SaveHabitResult`、`ListHabitsPageResult`
- 関数: `createHabit`→`createHabitUseCase` 等、Domain の同名関数と衝突しないよう use case は `createHabitUseCase`/`listHabitsUseCase`/`getHabitUseCase`/`updateHabitUseCase`/`archiveHabitUseCase` とする(`@habit-app/domain` の `createHabit`/`archiveHabit` とは別物)。`encodeHabitCursor`/`decodeHabitCursor`
- エラー: `HabitNotFoundError`、`HabitVersionConflictError`、`InvalidCursorError`

`HabitRepositoryPort`:

```ts
create(input: { actorUserId; habit; now }): Promise<HabitRecord>
findById(input: { actorUserId; habitId }): Promise<HabitRecord | null>
list(input: { actorUserId; status; limit; afterHabitId: string | null }):
  Promise<{ ok: true; items: HabitRecord[] } | { ok: false; reason: "cursor_not_found" }>
save(input: { actorUserId; habit; expectedVersion; now }):
  Promise<{ status: "saved"; record } | { status: "conflict" } | { status: "not_found" }>
```

Infrastructure: `createPrismaHabitRepository(prisma)`、`createUuidGenerator()`。

Contracts: `createHabitRequestSchema`、`updateHabitRequestSchema`、`archiveHabitRequestSchema`、`listHabitsQuerySchema`、`habitResponseSchema`、`habitListResponseSchema` と、それぞれの型。上限定数 `HABIT_NAME_MAX_LENGTH` 等。

HTTP 契約は Spec の APIとイベント節を正本とする。

## データMigration

- Expand/Backfill/Switch/Contract: N/A(スキーマ変更なし)。
- ロールバック/前方修正: コードの revert のみ。既に作成された habit 行は既存スキーマの範囲内であり、revert 後も整合する。

## セキュリティレビュー

- 認証/認可: 認証は Presentation で `auth()` の session から actor を取得(未取得なら 401)。認可は全 port メソッドの `actorUserId` 必須化と、全クエリへの `user_id` 条件で行う(取得後チェックに依存しない)。他ユーザーの habit/cursor は 404/422。
- 個人情報/Secret/ログ: 習慣の自由記述・body・cookie をログに出さない。route handler にログ出力を追加しない。test fixture は架空データのみ。
- 悪用対策: 入力上限(契約 schema)、body 16 KiB、`limit` 最大 100、未知キー拒否、制御文字拒否。Rate limit/Idempotency-Key は Spec の 受容リスク。
- CSRF: Origin 検証と `Content-Type: application/json` 必須。
- Injection: Prisma のパラメータ化クエリのみ。

## テスト計画

| 要件             | テスト種別  | 予定テスト                                                                                                                                                     |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain 追加      | Unit        | `habit.test.ts`: `reconstituteHabit` の正常復元(active/archived、複数版)、不変条件違反(重複期間、reduce の targetCount≠1、空の name)の拒否                     |
| HAPI-001〜005    | Unit        | `packages/application/src/habits/*.test.ts`: in-memory fake repository での各 use case(作成、version 不一致、archived、冪等アーカイブ、詳細+schedule 同時更新) |
| HAPI-002         | Unit        | `cursor.test.ts`: 往復、改ざん・不正形式・status 不一致の拒否                                                                                                  |
| HAPI-INV-005     | Unit        | `packages/contracts/src/habits.test.ts`: 境界値、制御文字、未知キー(`kind`)、空 PATCH、日付形式                                                                |
| HTTP 契約        | Unit        | `apps/web/src/server/habit-handlers.test.ts`: 401/403/404/409/413/415/422、Problem Details 形式、`Location`、`Cache-Control`                                   |
| HAPI-001〜005    | Integration | `prisma-habit-repository.integration.test.ts`: create→find 往復、list、save                                                                                    |
| HAPI-002         | Integration | 25 件ページング、status 絞り込み、同一 `created_at`、他ユーザー cursor 拒否                                                                                    |
| HAPI-INV-001     | Integration | user B の find/save/list(cursor 含む)が user A の習慣に到達できない                                                                                            |
| HAPI-INV-002/004 | Integration | 同一 version の並行 save で saved 1 / conflict 1、conflict 時に schedule が変更されない、schedule の effectiveTo 更新と新版追加が 1 transaction                |
| DB constraint    | Integration | 重複期間の exclusion、`UNIQUE(habit_id, effective_from)`、kind/days_of_week の CHECK が repository 経由でも DB 直接でも効く                                    |

Application の use case を実 repository と組み合わせた経路(`createHabitUseCase` → 実 DB)も同 Integration Test で 1 本確認する。E2E は基盤未導入のため対象外。

## 展開と運用

- Feature Flag: 不要(新規 route の追加のみ、UI からの導線は T-104 の範囲外)。
- デプロイ順序: Migration なしのため制約なし。T-102 とは独立にマージ可能(共有ファイルの追加のみの変更は衝突解消のみ)。
- メトリクス/アラーム: 追加なし(Spec 参照)。
- ロールバック条件と手順: 問題発生時は本 PR を revert する。DB に作成済みの習慣データは revert 後も有効。

## タスク分解

1. Spec/Plan 作成、Implementation Readiness Gate(本書)
2. Domain: `reconstituteHabit` + Unit Test
3. Contracts: `habits.ts` schema + Unit Test
4. Application: port/error/cursor、5 use case + fake repository + Unit Test
5. Infrastructure: `PrismaHabitRepository`、UUID generator + Integration Test(constraint、IDOR、409、pagination)
6. Presentation: handler、composition root、route 3 本 + handler の Unit Test
7. 文書更新(`docs/04`/`05`/`09`/`10`)
8. 品質コマンド一式(`format:check`/`lint`/`lint:boundaries`/`typecheck`/`build`/`test:unit`/`test:integration`)の実行、diff のセルフレビュー

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行 task: T-103(Domain)、T-101(session から actor 取得)、T-004(DB baseline)。いずれも main に取り込み済み。
- 並行 task: T-102(User/Profile)。共有ファイル(`packages/*/src/index.ts`、`packages/contracts/src/index.ts`、`apps/web/src/server/auth-container.ts`)への変更を追加のみに限定する。
- 外部権限/provider: 不要。Integration Test に Docker が必要。

## リスク

| リスク                                                                                       | 対策                                                                                                   | 責任者 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| `auth-container.ts` の変更が T-102 と衝突する                                                | 変更を `auth` の公開(2 行)に限定し、報告で明示する。衝突時はどちらも「追加」なので両方残して解決できる | TBD    |
| 暫定の文字数上限が後で変更される                                                             | 定数を契約 schema の 1 か所に集約。Domain/DB には置かない                                              | TBD    |
| `created_at` をアプリ側で設定するため、他 module が `now()` で挿入した行と時刻の精度が異なる | habits の挿入経路は本 repository のみ。keyset の比較は同一 table 内で完結する                          | TBD    |
| 永続化済みデータが Domain 不変条件に違反する場合に復元で失敗する                             | 復元失敗は 500 とし内容を出さない。DB 制約(CHECK/exclusion)で大半は防止済み                            | TBD    |
| Origin 検証で正当な非ブラウザ client を弾く                                                  | MVP の client は同一 origin の Web のみ。外部 client 対応時に認証方式とあわせて再設計する              | TBD    |

## 着手条件

- [x] Spec Status が Ready
- [x] 必須 ADR が Accepted(ADR-002 Prisma、ADR-009 REST、ADR-001 Auth。新規 ADR は不要)
- [x] API/event 契約がレビュー済み(Spec の APIとイベント節)
- [x] Migration 方針がレビュー済み(Migration なし)
- [x] 認可・データ保護方針がレビュー済み(Spec の セキュリティとプライバシー節)
- [x] テスト環境と Fake/Stub を準備できる(Testcontainers、in-memory fake)
- [x] 依存 task が完了している(T-001〜T-004、T-101、T-103)
- [x] rollout/rollback 方針が決定している(revert のみ)
- [x] 実装前ゲートの全必須項目が Pass または根拠付き N/A
