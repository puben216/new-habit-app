# User Profile Implementation Plan

Status: Ready
責任者: TBD
最終更新: 2026-10-02
Spec: [../specs/user-profile.md](../specs/user-profile.md)
変更区分: Standard(分類理由: 新規公開 API、DB schema 変更(制約追加)、認証・認可と個人情報(表示名)を扱うため。[change-classification.md](../governance/change-classification.md) の判定表に該当)

## 方針

[auth-adapter.md](auth-adapter.md) が実装済みの session を前提に、`identity` module(アーキテクチャ 3 章)として Domain → Application → Infrastructure → Presentation の順で追加する。

- Domain(`packages/domain/src/identity/`): 値オブジェクトの検証関数(`parseDisplayName`/`parseTimezone`/`isLocale`/`isWeekStartsOn`)、`validateProfileChanges`(複数違反を `InvalidProfileError` にまとめる)、`createDefaultProfile`。timezone は形(`Area/Location` または `UTC`、各セグメント英大文字始まり)を正規表現で検証した上で `Intl.DateTimeFormat` が受理することを確認する(Intl は ECMAScript 標準で、framework/ORM/HTTP ではないため Domain の純粋性を損なわない)。固定の許可リスト(`Intl.supportedValuesOf`)は ICU の旧名(`Asia/Katmandu` 等)により現行名を拒否するため採用せず、ID の置換もしない(Spec PROF-004)。
- Application(`packages/application/src/identity/`): `ProfileRepositoryPort`、`getMyProfile`、`updateMyProfile`、所有権 policy(`assertProfileOwnedByActor`)、`ProfileNotFoundError`。actor は `{ userId: string }` で受け取り、session の知識を持たない。
- Infrastructure(`packages/infrastructure/src/identity/`): `createPrismaProfileRepository`。`ensure` は `createMany({ skipDuplicates: true })`(`ON CONFLICT DO NOTHING`)+ `findUnique`。user 不存在による FK 違反(Prisma P2003)は `null` へ変換する。
- Presentation(`apps/web`): `src/server/profile-handlers.ts` に依存を注入できる handler factory(`getActorUserId`、use case、許可 Origin)を置き、`src/app/api/v1/me/route.ts` は container から依存を組み立てて委譲する薄い adapter とする。これにより Route 層の 401/403/413/415/422/404 変換を Next.js なしで Unit Test できる。`getActorUserId` は `auth()`(Auth.js)の session から `session-actor.ts` の純粋関数で `user.id` を取り出す(AUTH-009)。composition root は `profile-container.ts`(遅延 singleton)。
- Contracts(`packages/contracts/src/profile.ts`): `updateProfileRequestSchema`(`.strict()`、1 項目以上必須)、`profileResponseSchema`。値域・許可リストの正本は Domain とし、contracts は形と上限のみを持つ(二重定義による乖離を避ける)。

### 判断記録

- 遅延作成を採用し T-101 の signup transaction は変更しない。signup を変更すると T-101 の確定済み Spec/Plan/テストへ波及し、`display_name` 等の既定値を認証モジュールが知る必要が生じるため。
- `display_name` を nullable にして「未設定」を `NULL` で表す(空文字を意味のある値として扱わない)。
- 楽観ロックは導入しない(Spec Business Rules 参照)。

## 影響分析

| 領域           | 変更                                                                                                                                                                                                           | リスク                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Domain         | `identity/` を追加。`index.ts` に export 1 行追加                                                                                                                                                              | 低。Intl の受理可否が ICU 依存                              |
| Application    | `identity/` を追加。`index.ts` に export 1 行追加                                                                                                                                                              | 低                                                          |
| Infrastructure | `identity/PrismaProfileRepository` 追加、`index.ts` に export 1 行追加                                                                                                                                         | 低                                                          |
| Presentation   | `app/api/v1/me/route.ts`、`server/profile-handlers.ts`、`server/profile-container.ts`、`server/session-actor.ts` 追加。`server/auth-container.ts` に `auth` と `prisma` の公開を追加(既存ファイルへの追加のみ) | 中。`auth-container.ts` は T-104 とも共有されうる           |
| Database       | 新規 migration(`display_name` nullable 化、CHECK 4 本)。`schema.prisma` の `displayName` を `String?` に変更                                                                                                   | 中。Prisma Client 型が変わる(`displayName: string \| null`) |
| API/Event      | `GET/PATCH /api/v1/me`(新規)。event なし                                                                                                                                                                       | 低                                                          |
| AWS/Terraform  | なし                                                                                                                                                                                                           | なし                                                        |
| Observability  | 標準 log 項目のみ。表示名・body をログへ出さない                                                                                                                                                               | 低                                                          |

## インターフェースと契約

- Domain: `UserProfile = { displayName: string | null; timezone: string; locale: Locale; weekStartsOn: WeekStartsOn }`、`ProfileChanges`(各項目 optional)、`validateProfileChanges(input: unknown-shaped fields): ProfileChanges`(違反時 `InvalidProfileError`、`violations: { field, message }[]`)、`createDefaultProfile()`。
- Application: `ProfileRepositoryPort { ensure(userId, defaults): Promise<StoredProfile | null>; update(userId, changes): Promise<StoredProfile | null> }`(`null` は user 不存在)。`StoredProfile = UserProfile & { userId: string; updatedAt: Date }`。`getMyProfile(deps, actor)`、`updateMyProfile(deps, actor, input)`。
- API: Spec APIとイベント節。Problem Details は `@habit-app/contracts` の `createProblemDetails` を再利用する。
- Contracts: `UpdateProfileRequest`、`ProfileResponse`。

## データMigration

- Expand: `20261002000000_t102_user_profile_constraints`。`ALTER TABLE user_profiles ALTER COLUMN display_name DROP NOT NULL`、CHECK 制約 4 本(`week_starts_on`、`display_name` 長さ、`timezone` 長さ、`locale`)。
- Backfill: 不要(T-102 以前に書き込みコードが存在せず既存行なし)。適用前に `SELECT count(*) FROM user_profiles` で 0 または制約適合であることを確認する。
- Switch/Contract: 不要(互換性を壊さない loosening + 追加 CHECK)。
- ロールバック/前方修正: 原則 forward fix。戻す場合は CHECK を DROP し、`NULL` 行を既定値で埋めてから `NOT NULL` を復元する。
- 検証: fresh DB への全 migration 適用(Integration Test)、および T-101 時点の schema(`20260918002810`)までを適用した DB に本 migration を適用する upgrade 検証を Integration Test に含める。

## セキュリティレビュー

- 認証/認可: actor は session からのみ取得(`/api/v1/me` は対象 ID を受けない)。Repository の全 query は actor user ID を条件にする。Application の policy が取得結果の `userId` と actor の一致を再確認する(多層防御)。他ユーザー/不存在は 404。
- 個人情報/Secret/ログ: 表示名・body・cookie をログに出さない。エラー応答に入力値を含めない。fixture は架空データのみ。
- 悪用対策: body 4096 byte、各項目長上限、未知キー拒否、`Origin` 検証、`Content-Type` 検証。rate limit は Accepted Risk(Spec 参照)。

## テスト計画

| 要件                 | テスト種別  | 予定テスト                                                                                                                              |
| -------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| PROF-003             | Unit        | `display-name.test.ts`: 境界値、制御文字、bidi、サロゲートペア、NFC、trim                                                               |
| PROF-004             | Unit        | `timezone.test.ts`: 正規/別名/大文字小文字誤記/オフセット/略称/未知/長さ/DST・45 分・30 分オフセット地域                                |
| PROF-005/006         | Unit        | `locale.test.ts`、`week-starts-on.test.ts`、`profile.test.ts`(既定値、`validateProfileChanges` の複数違反集約)                          |
| PROF-001/002         | Unit        | `get-my-profile.test.ts`、`update-my-profile.test.ts`(Fake repository)                                                                  |
| PROF-007             | Unit        | `profile-policy.test.ts`、`update-my-profile.test.ts`(他ユーザー行 → NotFound)、`profile-handlers.test.ts`(401/403/404/413/415/422/200) |
| 契約                 | Unit        | `profile.test.ts`(contracts): strict、空 body、型違い                                                                                   |
| PROF-001/006/INV-001 | Integration | `prisma-profile-repository.integration.test.ts`: 遅延作成の既定値、並行 `ensure` で 1 行、user 不存在で `null`                          |
| PROF-002/007         | Integration | 指定項目のみ更新、user A の update が user B を変更しない                                                                               |
| PROF-INV-003/004     | Integration | CHECK 制約違反(長さ 0/51、week_starts_on -1/7、locale `fr`、timezone 長さ)の直接 SQL 拒否、migration の fresh/upgrade                   |
| E2E                  | 対象外      | Playwright 未導入(AGENTS.md)。導入後に onboarding profile シナリオを追加                                                                |

## 展開と運用

- Feature Flag: 不要(新規 endpoint、既存機能に影響なし)。
- デプロイ順序: migration(後方互換)→ アプリ。
- メトリクス/アラーム: 既存の 5xx 比率 alarm に含める。専用 alarm なし。
- ロールバック条件と手順: `/api/v1/me` の 5xx 急増時はアプリを直前 revision へ戻す。DB 制約はそのまま残す。

## タスク分解

1. Domain: 値オブジェクト・検証・既定プロフィール・エラー + Unit Test(設計確認 → 実装 → テスト → セルフレビュー)。
2. Contracts: request/response schema + Unit Test。
3. Application: port、use case、policy、Fake、Unit Test。
4. DB: migration、`schema.prisma`、`04-database-design.md` 更新、Prisma Client 再生成、schema integration test の追従。
5. Infrastructure: `PrismaProfileRepository` + Integration Test(所有権・遅延作成・CHECK・upgrade)。
6. Presentation: session-actor、handler factory + Unit Test、`profile-container.ts`、`/api/v1/me` route、`auth-container.ts` への `auth`/`prisma` 公開。
7. 文書: `04-database-design.md`、`09-roadmap.md`(T-102 の完了状況と E2E 対象外)。品質コマンド全実行、diff セルフレビュー。

## 依存関係

- 先行 task: T-101(session/Auth.js、完了済み)、T-004(DB baseline、完了済み)。
- 並行 task: T-104(Habit API)。共有ファイル(各 package の `index.ts`、`auth-container.ts`、`schema.prisma`、migration ディレクトリ)への変更は追加のみ・最小限とする。
- 外部アカウント・権限・provider: 不要。Docker(Testcontainers)がローカルで必要。

## リスク

| リスク                                                                                     | 対策                                                                                                                     | 責任者 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| `auth()` を Route Handler で呼ぶ際の Next.js/Auth.js の context 要件                       | handler factory は `getActorUserId` を注入し、`profile-container.ts` に `auth()` 利用を隔離。`build` で型・bundle を確認 | TBD    |
| Intl の受理可否が Node/ICU により差異                                                      | Unit Test は一般的な現行 ID と明確な不正値を中心にする。Node 更新時に検知                                                | TBD    |
| T-104 との共有ファイル衝突(`index.ts`、`auth-container.ts`、`schema.prisma`)               | 追加のみ・1 行単位の変更とし、衝突箇所を完了報告に明記                                                                   | TBD    |
| `displayName` の nullable 化で Prisma 型が変わり T-101 の schema integration test が壊れる | Task 4 で影響テストを確認し追従                                                                                          | TBD    |

## 着手条件

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted(ADR-001、ADR-002、ADR-009)
- [x] API/event契約がレビュー済み(Spec APIとイベント節、event は N/A)
- [x] Migration方針がレビュー済み(データMigration 節)
- [x] 認可・データ保護方針がレビュー済み(セキュリティレビュー 節)
- [x] テスト環境とFake/Stubを準備できる(Docker 稼働確認済み、`ProfileRepositoryPort` の Fake)
- [x] 依存taskが完了している(T-101、T-004)
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
