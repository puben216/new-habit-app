# Daily Check-in Implementation Plan

Status: Done
責任者: TBD
最終更新: 2026-10-03
Spec: [../specs/daily-check-in.md](../specs/daily-check-in.md)
変更区分: Standard

## 方針

T-202 と同じ層構成で縦に薄く実装する。DB の変更はない。

1. **Domain**(`packages/domain/src/tracking/`): `resolveDailyCheckIn(input)` を純粋関数として追加する。mood/difficulty の値域(1〜5 の整数)、メモの trim と空文字の未設定化、「少なくとも 1 項目」ルールを判定する。エラーは `InvalidDailyCheckInError`(`HabitDomainError` を継承。`field` を持つ)。
2. **Application**(`packages/application/src/tracking/`):
   - T-202 の `resolveLocalToday` を `local-today.ts` へ切り出し、`getTodayScheduleUseCase`/`upsertHabitEntryUseCase` と新 use case が共有する(振る舞いは変えない。既存の Unit/Integration Test が回帰を検知する)。プロフィールが無い場合は `null` を返し、呼び出し側が自分のエラーに変換する。
   - `DailyCheckInRepositoryPort`(`find`、`upsert`)、`getDailyCheckInUseCase`、`upsertDailyCheckInUseCase`、エラー(`CheckInDateOutOfRangeError`、`DailyCheckInNotFoundError`、`UserNotFoundError`)、定数 `CHECK_IN_BACKDATE_LIMIT_DAYS = 7`。
3. **Infrastructure**(`packages/infrastructure/src/tracking/`): `PrismaDailyCheckInRepository`。upsert は `INSERT ... ON CONFLICT (user_id, check_in_date) DO UPDATE ... RETURNING` の単一文(`$queryRaw` のタグ付きテンプレート)。取得は `findFirst`(`userId`、`checkInDate`)。
4. **Contracts**(`packages/contracts/src/check-in.ts`): `upsertDailyCheckInRequestSchema`(`.strict()`、`note` は 1〜1000 文字、`\n`/`\t` 以外の制御文字を拒否)、`dailyCheckInResponseSchema`、`checkInDateParamSchema`。
5. **Presentation**(`apps/web`): `check-in-handlers.ts`(`habit-http.ts` の共通処理を再利用)、`check-in-container.ts`、`app/api/v1/daily-check-ins/[date]/route.ts`(GET/PUT)。
6. **文書**: `docs/04`(実装時の補足)、`docs/05`(契約差分)、`docs/10`(P2 の暫定上限)、`docs/09`(roadmap)。

## 影響分析

| 領域           | 変更                                                                            | リスク                                         |
| -------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| Domain         | `tracking/` に関数とエラーを追加                                                | 低                                             |
| Application    | `tracking/` に use case・port・error を追加。`resolveLocalToday` を切り出し共有 | 低(既存テストが回帰を検知)                     |
| Infrastructure | `tracking/` に Prisma repository を追加                                         | 中(raw SQL の upsert。Integration Test で検証) |
| Presentation   | 新規 route 1 件と handler                                                       | 低                                             |
| Database       | 変更なし                                                                        | N/A                                            |
| API/Event      | 新規 endpoint 2 件(同一 path)                                                   | 低                                             |
| AWS/Terraform  | 変更なし                                                                        | N/A                                            |
| Observability  | 変更なし                                                                        | N/A                                            |

## インターフェースと契約

- Domain: `resolveDailyCheckIn`、型 `DailyCheckInInput`、`ResolvedDailyCheckIn`、`DAILY_CHECK_IN_SCALE_MIN/MAX`(1/5)、エラー `InvalidDailyCheckInError`。
- Application:
  - `DailyCheckInRepositoryPort`: `find({ actorUserId, date }): Promise<DailyCheckInRecord | null>`、`upsert({ actorUserId, date, mood, difficulty, note, now }): Promise<DailyCheckInRecord | null>`(user が存在しなければ `null`)。
  - `DailyCheckInRecord { date, mood, difficulty, note, createdAt, updatedAt }`。
  - use case: `getDailyCheckInUseCase(deps, { actorUserId, date })`、`upsertDailyCheckInUseCase(deps, { actorUserId, date, mood, difficulty, note })`。
- Contracts / HTTP: Spec の APIとイベント節のとおり。

## データMigration

- Expand/Backfill/Switch/Contract: N/A。DB スキーマ変更なし(既存の制約・index で足りる)。
- ロールバック/前方修正: アプリの revert のみで完結する。

## セキュリティレビュー

- 認証/認可: session から actor を取得し、repository の全 query に actor user ID を渡す。path に user を含めない。
- 個人情報/Secret/ログ: メモ・気分・難易度・body をログに出さない。route に独自ログを追加しない。fixture は架空データのみ。
- 悪用対策: メモ 1000 文字、body 16 KiB、対象日の範囲。Rate limit は Accepted Risk。
- SQL: raw SQL はタグ付きテンプレートのバインド変数のみ。

## テスト計画

| 要件        | テスト種別  | 予定テスト                                                                                                                                                         |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DCI-002     | Unit        | `daily-check-in.test.ts`: mood/difficulty の 0/1/5/6・小数、メモの trim/空白のみ、全項目未設定、一部のみ設定                                                       |
| DCI-001/003 | Unit        | `check-in.test.ts`: 作成/訂正(置換)/再送、範囲境界(今日・7 日前・8 日前・未来)、Asia/Tokyo の繰り上がり、DST 日、習慣なしでも可、user 不存在、actor が repo に渡る |
| DCI-004     | Unit        | `check-in.test.ts`: 取得/なし、他ユーザー分離                                                                                                                      |
| 契約        | Unit        | `contracts/check-in.test.ts`: 未知キー、値域、メモ 1000/1001、`\n`/`\t` 可・他の制御文字不可、日付形式                                                             |
| HTTP        | Unit        | `check-in-handlers.test.ts`: 401/403/404/413/415/422 のマッピング、body の user 指定拒否                                                                           |
| DCI-001/004 | Integration | `prisma-daily-check-in-repository.integration.test.ts`: upsert 往復、置換、再送、並行 6 件で 1 レコード、取得                                                      |
| DCI-INV-001 | Integration | 同日の他ユーザーのチェックインと混ざらない、user 不存在で `null`                                                                                                   |
| DB 制約     | Integration | mood/difficulty の CHECK(0/6 を拒否)、一意制約                                                                                                                     |

## 展開と運用

- Feature Flag: 不要(新規 route のみ)。
- デプロイ順序: 制約なし(Migration なし)。
- メトリクス/アラーム: 追加なし。
- ロールバック条件と手順: 不具合時はアプリを revert する。

## タスク分解

1. Feature Spec と Plan の作成、Readiness Gate 評価(本文書)
2. Domain: `resolveDailyCheckIn` + Unit Test
3. Application: `resolveLocalToday` の切り出し、port、use case、error、fake + Unit Test
4. Infrastructure: `PrismaDailyCheckInRepository` + Integration Test
5. Contracts: schema + Unit Test
6. Presentation: handler、container、route + Unit Test
7. 文書更新(`docs/04`、`05`、`09`、`10`)
8. 品質コマンド一式(`test:integration` を含む)の実行、セルフレビュー、PR 作成

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行 task: T-101(session)、T-102(timezone)、T-201(`localDateAt`。PR #12)、T-202(`resolveLocalToday`、共通 HTTP 処理。PR #13)。本ブランチは T-202 のブランチを起点にし、#12/#13 の merge 後に main へ付け替える。
- ADR 依存、外部権限、provider: なし。

## リスク

| リスク                                                | 対策                                                           | 責任者 |
| ----------------------------------------------------- | -------------------------------------------------------------- | ------ |
| `resolveLocalToday` の切り出しで T-202 の挙動が変わる | 既存の T-202 Unit/Integration Test を変更せず通す              | TBD    |
| 積み上げた PR(#12→#13→本 PR)の merge 順序             | base を前段のブランチにし、前段の merge 後に main へ付け替える | TBD    |
| メモの暫定上限(1000)が後で変わる                      | 契約 schema の定数のみに置き、DB には焼き込まない              | TBD    |

## 着手条件

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(該当ADRなし)
- [x] API/event契約がレビュー済み、またはN/A(Spec の APIとイベント節)
- [x] Migration方針がレビュー済み、またはN/A(migrationなし)
- [x] 認可・データ保護方針がレビュー済み(セキュリティとプライバシー節)
- [x] テスト環境とFake/Stubを準備できる(Testcontainers、既存 fake)
- [x] 依存taskが完了している(T-201/T-202 は PR review 待ちだがコードは本ブランチに含まれる)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
