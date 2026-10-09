# 認証画面 Implementation Plan

Status: Ready
責任者: TBD
最終更新: 2026-10-09
Spec: [../specs/auth-screens.md](../specs/auth-screens.md)
変更区分: Standard

## 方針

T-101 の API と Auth.js をそのまま消費し、`apps/web` の Presentation だけを追加・変更する。基盤は [ADR-010](../adr/ADR-010-web-ui-stack.md) と T-211 の部品を再利用する。

1. **純粋ロジック(`lib/auth/`)**: 画面から切り離して Unit で検証できるようにする。
   - `next-path.ts`: `sanitizeNextPath(raw): string`(許可リスト方式。不正は `/today`)と `buildLoginPath({ next, reason })`。
   - `validation.ts`: `validateEmail`/`validatePassword`/`validateToken`(必須・上限・形式の目安のみ)。戻り値は項目キーのエラー種別(`required`/`too_long`/`format`)で、文言は持たない。
   - `messages.ts`: 固定文言の定数(login 失敗文言は 1 つの定数)と、`fieldErrors` のキー → 固定文言の対応。
   - `auth-client.ts`: Auth.js 標準 endpoint の client。`signInWithPassword`(csrf 取得 → credentials callback(form, `json=true`)→ `/api/auth/session` で `user.id` を確認)と `signOut`。`fetch` を注入可能。通信例外だけを `ApiError(network_error)` にし、認証の失敗はすべて `"invalid_credentials"` にまとめる。
2. **共通フォーム部品(`components/`)**: `TextField`(label、hint、error、`aria-invalid`/`aria-describedby`)、`ErrorSummary`(`role="alert"`、`tabIndex={-1}`、フォーカス移動、項目へのリンク)、`FormShell`(タイトル+フォーム余白)。CSS Modules。
3. **proxy(`src/proxy.ts`)**: `x-pathname`(path+query)を request header に常に上書きして付与する関数 `withPathnameHeader` と、`proxy` の薄い export。matcher は `/api`、`_next`、静的ファイルを除外。
4. **ガードの更新**: `server/require-session.ts` が `headers()` の `x-pathname` から `buildLoginPath` で `/login?next=…` へ redirect。`(app)` layout 以外の layout は変えない。認証済みを `/today` へ戻す `redirectIfSignedIn()` を追加し、`(guest)` route group の layout で使う。
5. **route 構成**: 既存 `(public)/login` を `(guest)/login` へ移し、`(guest)/signup`、`(guest)/password-reset` を追加。`(public)/verify-email`、`(public)/password-reset/confirm` を追加。各 page は Server Component で `searchParams` を読み、client のフォーム component に必要な値(`next`、`reason`、`token` の有無)を渡す。token はフォームの state へ移した直後に `history.replaceState` で URL から除去する。
6. **フォーム component(client)**: `SignupForm`、`LoginForm`、`VerifyEmailPanel`(確認/再送)、`PasswordResetRequestForm`、`PasswordResetConfirmForm`。`useMutation` で `apiRequest`(`/api/v1/auth/*`)または `auth-client` を呼ぶ。状態表示は `StateMessage` を再利用。
7. **logout**: `components/logout-button.tsx`(client)を `(app)` layout のヘッダーに追加。`Providers` の 401 処理は `buildLoginPath({ next: 現在の path, reason: "session_expired" })` に更新。
8. **セキュリティヘッダー**: `next.config.ts` の `headers()` で全 route に `X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff` を付与する。
9. **E2E**: 既存 smoke の redirect 期待値を `next` 付きに更新。`e2e/auth.spec.ts`(一連、列挙の非漏洩、reset、next、認証済み redirect、入力エラー、二重送信)。Mailpit helper は T-211 のものを再利用し、reset メール用の `subject` を追加指定する。
10. **文書**: `docs/09` の T-212 に設計・実装・テストの記録、`docs/10` は変更なし(新しい決定は Spec に記載)。

## 影響分析

| 領域           | 変更                                                        | リスク                                                                     |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Domain         | なし                                                        | なし                                                                       |
| Application    | なし                                                        | なし                                                                       |
| Infrastructure | なし                                                        | なし                                                                       |
| Presentation   | 認証画面、フォーム部品、proxy、ガード更新、logout、ヘッダー | 中(`login` の route 移動、全 route へのヘッダー付与が既存画面へ与える影響) |
| Database       | なし                                                        | なし                                                                       |
| API/Event      | なし                                                        | なし                                                                       |
| AWS/Terraform  | なし                                                        | なし                                                                       |
| Observability  | なし                                                        | なし                                                                       |

## インターフェースと契約

- `sanitizeNextPath(raw: string | string[] | undefined): string`、`buildLoginPath(options): string`。
- `validateEmail(value)`/`validatePassword(value)`/`validateToken(value)`: `"required" | "too_long" | "format" | null`。
- `signInWithPassword({ email, password, fetchImpl? }): Promise<"success" | "invalid_credentials">`、`signOut({ fetchImpl? }): Promise<void>`。通信例外は `ApiError(network_error)` を投げる。
- `withPathnameHeader(request: Request): Headers`(proxy の純粋部分)。
- 画面 route: `/signup`、`/login`、`/verify-email`、`/password-reset`、`/password-reset/confirm`。

## データMigration

N/A。DB の変更がないためロールバックは PR の revert のみ。

## セキュリティレビュー

- 認証/認可: 保護はサーバー(`(app)` layout の DB session 検証、API の認可)。proxy は認証を判定せず header を付けるだけ。client の状態を認証の根拠にしない。
- 個人情報/Secret/ログ: password・token・email をログ・URL(送信後)・storage に出さない。固定文言のみ描画。E2E の fixture は架空データ。
- 悪用対策: 列挙の非漏洩(文言・要素の統一)、open redirect(許可リスト)、clickjacking(ヘッダー)、token のリファラ漏えい(`no-referrer`)、二重送信の抑止。

## テスト計画

| 要件            | テスト種別  | 予定テスト                                                                                                                                            |
| --------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUI-007         | Unit(+性質) | `sanitizeNextPath`: 任意の入力で結果が `/` 始まり・`//`/`\`/スキーム/制御文字なし(性質)、敵対的入力一覧、`buildLoginPath` の往復                      |
| AUI-002/005/006 | Unit(+性質) | `validate*`: 空・上限境界(254/128/512)・形式、任意の文字列で例外を投げない(性質)                                                                      |
| AUI-004/008     | Unit        | `auth-client`: csrf → callback → session の順序と form 本文、session 無し/callback 4xx/5xx → `invalid_credentials`、fetch 例外 → network_error        |
| AUI-001         | Unit        | `TextField`/`ErrorSummary` の属性(label の関連付け、`aria-invalid`、`aria-describedby`、`role="alert"`)                                               |
| AUI-INV-001     | Unit        | login 失敗文言が単一定数、`fieldErrors` マップが未知キーでフォーム全体の固定文言になる                                                                |
| AUI-007         | Unit        | `withPathnameHeader`: クライアント指定の `x-pathname` を上書きする                                                                                    |
| 全体            | E2E         | Spec 受け入れ基準の全シナリオ(一連、列挙、reset、next、open redirect、認証済み redirect、入力エラー、無効 token、二重送信、logout 後の旧 cookie 無効) |

テスト品質の 3 観点: 性質テストは fast-check。変異テストは Stryker 未導入のため、`sanitizeNextPath`、`validate*`、`auth-client`、`withPathnameHeader`、列挙対策の定数を手動で壊して Unit/E2E が失敗することを確認し、生存した変異にはテストを追加する。敵対的審査として、実装後の差分を攻撃者視点(列挙、open redirect、token 漏えい)と a11y 視点で読み、結果を完了報告に記載する。

## 展開と運用

- Feature Flag: 不要。
- デプロイ順序: 通常のマージのみ。
- メトリクス/アラーム: N/A。
- ロールバック条件と手順: 認証が通らない、または既存画面が壊れた場合に PR を revert。

## タスク分解

1. 純粋ロジック(`next-path`、`validation`、`messages`、`auth-client`)と Unit(性質テスト含む)。
2. フォーム部品(`TextField`、`ErrorSummary`)と Unit。
3. proxy、ガード更新(`next` 付き redirect)、`redirectIfSignedIn`、セキュリティヘッダー。
4. 画面(signup、login、verify-email、password-reset、confirm)と logout、401 処理の更新。
5. E2E(既存 smoke の更新+`auth.spec.ts`)。
6. 文書(`docs/09`)、セルフレビュー、全品質コマンドの実行。

各 task は「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## 依存関係

- 先行: T-101(auth API)、T-211(UI 基盤・E2E 基盤)。いずれも完了済み。
- 外部: Docker(Postgres、Mailpit)、Chromium。

## リスク

| リスク                                                             | 対策                                                                                       | 責任者 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------ |
| Auth.js の credentials callback(`json=true`)の応答形式が想定と違う | 応答本文に依存せず `/api/auth/session` で成否を判定する。実装初期に実測する                | TBD    |
| `proxy.ts` が Next 16 の想定どおり request header を伝播しない     | 早期に E2E で `next` 付き redirect を確認。動かない場合は別の方法(page 側の guard)を再設計 | TBD    |
| 全 route へのヘッダー付与が dev/E2E の挙動を変える                 | E2E と build で確認                                                                        | TBD    |
| login 失敗の表示差(要素・タイミング)がテストで検出されない         | E2E で 3 種の失敗の本文を比較する                                                          | TBD    |

## 着手条件

- [x] Spec Status が Ready
- [x] 必須 ADR(ADR-010)が Accepted
- [x] API/event 契約がレビュー済み、または N/A(N/A)
- [x] Migration 方針がレビュー済み、または N/A(N/A)
- [x] 認可・データ保護方針がレビュー済み
- [x] テスト環境と Fake/Stub を準備できる(Docker、Mailpit)
- [x] 依存 task が完了している
- [x] rollout/rollback 方針が決定している
- [x] 実装前ゲートの全必須項目が Pass または根拠付き N/A
