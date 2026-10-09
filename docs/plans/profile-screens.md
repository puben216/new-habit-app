# オンボーディングとプロフィール画面 Implementation Plan

Status: Ready
責任者: TBD
最終更新: 2026-10-09
Spec: [../specs/profile-screens.md](../specs/profile-screens.md)
変更区分: Standard

## 方針

T-102 の API を消費する Presentation の追加と、オンボーディング完了判定の Application への追加のみ。

1. **Domain/Application**: `hasCompletedOnboarding(profile: { displayName: string | null }): boolean`(Domain の identity)。Application の identity index から re-export し、Unit で検証。
2. **server**: `profile-container.ts` に `getProfileForActor(userId)`(`getMyProfile` use case を呼ぶ)を追加。`require-onboarded.ts`: `guardOnboarded({ getProfile, redirectToOnboarding })` と `guardNotOnboarding({ ..., redirectToApp })`(依存注入できる純粋寄りの関数)と、Next 用の薄い wrapper。
3. **route 構成**: `(app)/today` を `(app)/(onboarded)/today` へ移動。`(app)/(onboarded)/layout.tsx`(未完了なら `/onboarding`)、`(app)/(onboarded)/profile/page.tsx`、`(app)/onboarding/page.tsx`(完了済みなら `/today`)。いずれも `dynamic = "force-dynamic"` は親 `(app)` layout が持つ。
4. **lib/profile**: `timezone-options.ts`(選択肢の構築: 重複排除・ソート・`UTC` と現在値の追加)、`validation.ts`(表示名の必須・50 code point)、`messages.ts`(固定文言と `fieldErrors` キー → 文言)、`profile-api.ts`(`fetchProfile`/`updateProfile` を `apiRequest` + `profileResponseSchema` で)。
5. **features/profile**: `ProfileForm`(onboarding/profile 共通。`mode` で文言と遷移を切り替え)。`useQuery(["me"])` と `useMutation`。タイムゾーンの選択肢は page(Server Component)が `Intl.supportedValuesOf` から作って渡す。`SelectField` 部品(`TextField` と同じ a11y 規約)を `components/` に追加。
6. **nav**: `NAV_ITEMS` に `/profile` を追加。
7. **E2E**: `support/auth.ts` に `onboardUser` を追加し、`registerVerifiedUser`/`signUpAndSignIn` が既定でオンボーディングまで済ませる(`{ onboarded: false }` で無効化)。既存 T-212 の一連テストは `/onboarding` を経由する形へ更新。`e2e/profile.spec.ts` を追加。
8. **文書**: `docs/09` の T-213。

## 影響分析

| 領域           | 変更                                                           | リスク                                                 |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| Domain         | `hasCompletedOnboarding` を追加                                | 低                                                     |
| Application    | re-export のみ                                                 | 低                                                     |
| Infrastructure | なし                                                           | なし                                                   |
| Presentation   | 画面 2 つ、layout、フォーム、nav、`/today` の route group 移動 | 中(既存 E2E が `/onboarding` 経由になる。更新して確認) |
| Database       | なし                                                           | なし                                                   |
| API/Event      | なし                                                           | なし                                                   |
| Observability  | なし                                                           | なし                                                   |

## インターフェースと契約

- `hasCompletedOnboarding(profile)`、`guardOnboarded`、`guardNotOnboarding`。
- `buildTimezoneOptions(supported, current)`、`validateDisplayName(value)`、`fetchProfile()`/`updateProfile(changes)`。
- E2E: `onboardUser(email, password)`、`signUpAndSignIn(context, user?, options?)`。

## データMigration

N/A。

## セキュリティレビュー

- 認証/認可: 保護は server(session と API)。画面は `/me` のみ。
- 個人情報/ログ: 表示名・timezone を出さない。fixture は架空。
- 悪用対策: React のエスケープ、HTML 文字列の表示名を E2E で確認、Origin 検証は既存。

## テスト計画

| 要件    | テスト種別  | 予定テスト                                                                               |
| ------- | ----------- | ---------------------------------------------------------------------------------------- |
| PFS-001 | Unit        | `hasCompletedOnboarding`、`guardOnboarded`/`guardNotOnboarding`                          |
| PFS-002 | Unit(+性質) | `buildTimezoneOptions`: 現在値と UTC を必ず含む・重複なし・ソート済み(性質)              |
| PFS-004 | Unit(+性質) | `validateDisplayName`: code point 境界(絵文字・サロゲートペア)、`fieldErrors` → 固定文言 |
| 全体    | E2E         | Spec 受け入れ基準の全シナリオ                                                            |

3 観点: 性質テストは fast-check、変異テストは手動(判定関数・ガード・選択肢構築・検証の境界)、敵対的審査は実装後に差分を読み結果を報告。

## 展開と運用

- Feature Flag: 不要。ロールバック: revert。

## タスク分解

1. Domain/Application の判定関数と server ガード、Unit。
2. lib/profile と Unit。
3. `SelectField`、`ProfileForm`、画面と route 構成、nav。
4. E2E helper の更新と既存 E2E の修正、`profile.spec.ts`。
5. 文書、セルフレビュー、全品質コマンド。

## 依存関係

- 先行: T-102、T-211、T-212(完了済み)。

## リスク

| リスク                                                               | 対策                                                    | 責任者 |
| -------------------------------------------------------------------- | ------------------------------------------------------- | ------ |
| `Intl.supportedValuesOf` の server/browser 差による hydration 不整合 | 選択肢は server で作って props で渡す                   | TBD    |
| 既存 E2E がオンボーディングで壊れる                                  | helper で既定オンボーディング、一連テストを明示的に更新 | TBD    |

## 着手条件

- [x] Spec が Ready
- [x] 必須 ADR(ADR-010)が Accepted
- [x] API/event 契約: N/A
- [x] Migration: N/A
- [x] 認可・データ保護方針がレビュー済み
- [x] テスト環境
- [x] 依存 task が完了している
- [x] rollout/rollback 方針が決定している
- [x] 実装前ゲートの全必須項目が Pass または根拠付き N/A
