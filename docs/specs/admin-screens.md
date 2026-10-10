# 管理画面 Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-10
変更区分: Standard
ロードマップ項目: T-403(PR-B)

## 目的

T-403 PR-A の `/api/v1/admin/*` を、Admin が使う最小の read-only 画面として提供する。MFA(TOTP またはリカバリーコード)の検証、ユーザー検索と概要、通知配送の失敗一覧、AI ジョブの失敗一覧を扱う。権限・MFA・監査の判定は API 側が担い、画面は UX のための誘導と表示だけを行う。業務ルールは [minimal-admin.md](minimal-admin.md)、基盤は [web-ui-foundation.md](web-ui-foundation.md)、方式は [ADR-010](../adr/ADR-010-web-ui-stack.md)、[ADR-012](../adr/ADR-012-admin-access.md) に従う。

## 成功指標

- Member は `/admin` 配下のどの画面でも、通常の「ページが見つかりません」と区別できない表示(404)になり、管理画面の存在を推測できない(E2E)。
- Admin が MFA を検証するまで、閲覧画面は一切描画されず `/admin/mfa` へ誘導される。検証後は元の画面に戻る(E2E)。
- ユーザー検索の email が URL・履歴・storage・ログに残らない(Unit/E2E)。
- 画面に表示するのは API が返す allowlist の項目だけで、マスクされた email 以外の個人情報を画面側で取得・補完しない(Unit)。
- すべての画面がキーボードだけで操作でき、状態(失敗・期限切れ・抑止)が色だけに依存せず文字でも示される(E2E、a11y 点検)。

## 範囲

- 画面(`(admin)` route group): `/admin/mfa`、`/admin`(トップ)、`/admin/users`(検索)、`/admin/users/[publicId]`(概要)、`/admin/notifications`(通知配送の失敗)、`/admin/ai-jobs`(AI ジョブの失敗)。
- route の保護(Server Component の layout): 未認証 → login、Admin でない → 404、MFA 未検証/期限切れ → `/admin/mfa`。
- 管理用のナビゲーションとヘッダー(Member 向けナビゲーションとは別。Member の画面から管理画面へのリンクは作らない)。
- Playwright E2E、Runbook の更新(`/admin/mfa` の手順)。

## 対象外

- API・DB の変更(Migration なし)。書き込み操作(停止、再送、suppression 解除など)。
- 監査ログの閲覧画面、ユーザー一覧の列挙、部分一致検索、CSV 出力。
- MFA の登録(QR コード表示)。登録は運用スクリプトで行う(ADM-001)。
- 管理者の付与・無効化の画面。

## アクターと前提条件

| アクター            | 前提条件                              | 画面の挙動                                      |
| ------------------- | ------------------------------------- | ----------------------------------------------- |
| Guest(未認証)       | なし                                  | `/login?next=…` へ redirect                     |
| Member              | login 済み。有効な `admin_users` なし | 404 の画面(通常の not-found と同一)             |
| Admin(MFA 未検証)   | login 済み。有効な Admin              | `/admin/mfa` のみ表示。他は `/admin/mfa` へ誘導 |
| Admin(MFA 検証済み) | 検証から 30 分以内                    | すべての画面を利用できる                        |

## 機能要件

### ADS-001 route の保護

- `/admin` 配下の layout は Server Component とし、まず DB session を検証する(未認証は `/login?next=<現在の path>` へ redirect)。
- 続いて Application の `authorizeAdmin`(API と同じ判定)を呼び、`not_admin` なら `notFound()` を返す。Member に管理画面の存在を明かさないため、リダイレクトや独自の文言は使わない。
- MFA 検証済みのときだけ使う画面は route group `(verified)` に置き、`mfa_required` なら `/admin/mfa?next=<現在の path>` へ redirect する。`/admin/mfa` は group の外に置き、検証済みなら `next`(または `/admin`)へ redirect する。
- `next` は `/admin` 配下の path だけを許可する(`/admin/mfa` 自身と他の path は `/admin` にする)。既存の `parseNextPath` の検証を通した上で絞り込む。

### ADS-002 MFA の検証(`/admin/mfa`)

- 入力欄 1 つ(ラベル「確認コード」、補足「認証アプリの 6 桁のコード、またはリカバリーコードを入力してください」)。`autocomplete="one-time-code"`、`autocapitalize="off"`、`spellcheck="false"`。
- 送信は `POST /api/v1/admin/mfa/verify`(body `{ code }`)。成功したら `router.replace(next)` と `router.refresh()` で Server Component の判定をやり直す。
- 失敗は固定文言で表示し、コードの入力欄は必ず空に戻す。`403 invalid_mfa_code` →「コードが正しくありません。もう一度入力してください。」、`429 mfa_locked` →「試行回数の上限に達しました。しばらく待ってからもう一度お試しください。」、`404` → 画面を再評価(refresh)して判定に任せる、その他・通信失敗は共通の固定文言。TOTP とリカバリーコードのどちらが誤りかは区別して表示しない。
- 入力したコードを URL・storage・ログ・エラー表示に出さない。送信中はボタンを無効化して二重送信しない。

### ADS-003 トップ(`/admin`)

- `GET /api/v1/admin/me` を取得し、検証の有効期限(UTC の時刻)と、各画面(ユーザー検索、通知配送の失敗、AI ジョブの失敗)へのリンクを表示する。

### ADS-004 ユーザー検索(`/admin/users`)

- email 入力と「検索」ボタン。送信時に `GET /api/v1/admin/users?email=…` を呼ぶ。email は component の state にだけ持ち、画面の URL・storage に載せない。
- 結果は 0 件または 1 件。1 件なら「マスクされた email」「状態」「登録日時」と概要へのリンク。0 件なら「該当するユーザーは見つかりませんでした」(存在確認の挙動を一定にするため、近い候補を出さない)。
- client 検証(UX)は空と形式(email らしさ)のみ。`422` は固定文言。検索結果の件数を `role="status"` で通知する。

### ADS-005 ユーザー概要(`/admin/users/[publicId]`)

- `GET /api/v1/admin/users/{publicId}` の項目(マスクされた email、状態、登録日時、email 確認済みか、通知の抑止(suppression)の有無と直近 30 日の配送の状態別件数、直近 30 日の AI ジョブの状態別件数)を定義リスト/表で表示する。
- `404`(UUID でない ID を含む)は「ユーザーが見つかりません」。取得のたびに閲覧が監査される旨を画面に常に示す。

### ADS-006 通知配送の失敗(`/admin/notifications`)

- `GET /api/v1/admin/operations/notifications` を新しい順に表示する。状態の絞り込み(すべて/失敗/期限切れ/配信停止)は `status` クエリ(個人情報を含まない)で切り替え、現在の選択に `aria-current` を付ける。
- 列: 配送 ID、ユーザー公開 ID(概要へのリンク)、状態、失敗コード、試行回数、予定日時、現地日付、更新日時。`nextCursor` があれば「さらに表示」。空なら空状態。

### ADS-007 AI ジョブの失敗(`/admin/ai-jobs`)

- ADS-006 と同様の構造(絞り込み: すべて/失敗/フォールバック)。列: ジョブ公開 ID、ユーザー公開 ID、種別、状態、失敗コード、provider、model、prompt version、作成日時。入出力・本文は API が返さないため表示しない。失敗したジョブがなければ空状態。

### ADS-008 共通

- 日時は UTC の固定書式(`YYYY-MM-DD HH:mm UTC`)で表示し、利用者の端末の timezone に依存しない。状態コードは日本語ラベルに対応付け、未知のコードはそのまま(コード値)表示する。
- 取得失敗は再試行できるエラー表示。API が `403 mfa_required`(30 分の期限切れ)を返したら `/admin/mfa?next=<現在の path>` へ移る。`401` は共通処理で login へ。`404` は「見つかりません」の表示。
- 管理画面は `noindex`(`robots` metadata)にし、データ取得のキャッシュは保持しない(`gcTime: 0`)。

## 業務ルールと不変条件

- ADS-INV-001(判定を持たない): Admin かどうか・MFA が有効かの判定は `authorizeAdmin`/API が行う。画面は結果に応じた表示・誘導のみで、Admin の状態を client の storage や cookie に持たない。
- ADS-INV-002(存在の秘匿): Member への応答は通常の 404 画面と同じ。管理画面専用の文言・リダイレクト・レスポンスヘッダーの差を作らない。
- ADS-INV-003(最小露出): 画面に出す個人情報は API が返すマスク済み email と公開 ID のみ。検索に使った email を URL・履歴・storage・ログ・クエリキーに残さない(クエリキーには email を含めず、結果は `useMutation` で扱う)。
- ADS-INV-004(server 文言の非描画): WUI-INV-003 と同じ。API の `message`/`fieldErrors` の文字列は描画せず、`status`/`code` から固定の文言を選ぶ。
- ADS-INV-005(read-only): 画面は `GET` と `POST /admin/mfa/verify` 以外を呼ばない。
- ADS-INV-006(MFA コードの非保持): 入力したコードは送信後すぐ state から消し、失敗時も復元しない。

## 状態遷移

| 現在                 | 操作                     | 次                    | 備考                            |
| -------------------- | ------------------------ | --------------------- | ------------------------------- |
| MFA 未検証の Admin   | 閲覧画面を開く           | `/admin/mfa?next=…`   | layout が redirect              |
| MFA 未検証の Admin   | 正しいコードを送信       | `next`(既定 `/admin`) | session 単位で 30 分有効        |
| MFA 未検証の Admin   | 誤ったコードを送信       | 同じ画面(エラー表示)  | 5 回連続で 15 分ロック(API)     |
| MFA 検証済みの Admin | 30 分経過後に API を呼ぶ | `/admin/mfa?next=…`   | `403 mfa_required` を受けて移動 |
| MFA 検証済みの Admin | `/admin/mfa` を開く      | `next`(既定 `/admin`) | 検証済みなら入力不要            |

## 受け入れ基準

```gherkin
Scenario: Member には管理画面が存在しない
  Given 通常の Member が login している
  When /admin、/admin/users、/admin/mfa を開く
  Then いずれも「ページが見つかりません」が表示される
  And Admin 専用のナビゲーションや文言は含まれない

Scenario: 未認証は login へ
  When 未認証で /admin/users を開く
  Then /login?next=%2Fadmin%2Fusers へ移る

Scenario: MFA 未検証の Admin は検証画面へ誘導される
  Given 有効な Admin が login したが MFA を検証していない
  When /admin/notifications を開く
  Then /admin/mfa?next=%2Fadmin%2Fnotifications へ移り、閲覧画面は描画されない

Scenario: MFA を検証して元の画面に戻る
  Given 上記の状態
  When 正しい TOTP を入力して送信する
  Then /admin/notifications が表示される

Scenario: 誤ったコードと入力の消去
  When 誤ったコードを送信する
  Then 固定文言のエラーが表示され、入力欄は空になる
  And 正しいコードで再度送信すると成功する

Scenario: リカバリーコードは一度だけ使える
  When 未使用のリカバリーコードで検証する
  Then 成功し、別の session で同じコードを使うと失敗する

Scenario: ユーザー検索はマスク表示で、email が URL に残らない
  Given MFA 検証済みの Admin
  When 登録済み email を完全一致で検索する
  Then マスクされた email(全体は表示されない)と概要へのリンクが表示される
  And ページの URL に email が含まれない
  And 登録されていない email は「見つかりませんでした」になる

Scenario: ユーザー概要
  When 概要を開く
  Then 状態、登録日時、email 確認済みか、通知・AI ジョブの件数が表示され、email の全体・習慣名は表示されない

Scenario: 失敗一覧
  Given 失敗した配送がある
  When /admin/notifications を開く
  Then 状態、失敗コード、試行回数が文字で表示され、絞り込みと「さらに表示」が使える
  And 配送がなければ空状態が表示される

Scenario: 監査に残る
  When 検索・概要・一覧を開く
  Then audit_logs に admin.user.search / admin.user.view / admin.notifications.list が追記され、検索した email は含まれない

Scenario: 無効化された Admin
  Given Admin が admin:disable で無効化された
  When 次の画面遷移・リロードをする
  Then 404 の画面になる
```

## 認可マトリクス

| 画面                  | Guest | Member | Admin(MFA 未検証) | Admin(MFA 検証済み) |
| --------------------- | ----- | ------ | ----------------- | ------------------- |
| /admin/mfa            | login | 404    | Yes               | `/admin` へ         |
| /admin、/admin/users… | login | 404    | `/admin/mfa` へ   | Yes                 |

画面の保護は UX のためで、データの保護は API(minimal-admin.md の認可マトリクス)が担う。

## APIとイベント

新規 API なし。使用する API は minimal-admin.md の「APIとイベント」のとおり(`GET /admin/me`、`POST /admin/mfa/verify`、`GET /admin/users`、`GET /admin/users/{publicId}`、`GET /admin/operations/notifications`、`GET /admin/operations/ai-jobs`)。画面は型付き API client と contracts の runtime schema で応答を検証する(ADR-009)。Events は発行しない。

## データとMigration

変更なし(Migration なし)。ロールバックはアプリの revert。

## 失敗・境界ケース

- API の `500`(鍵未設定など): 固定のエラー表示と再試行。内部情報は出さない。
- `429 mfa_locked`: ロックの旨を表示し、試行を続けさせない案内(待つ)にする。
- 検索 email の形式不正: client 検証と `422` の両方で同じ固定文言。
- `publicId` が UUID でない: API client の path 検証または `404` により「ユーザーが見つかりません」。
- 一覧の最終ページ: `nextCursor` が `null` なら「さらに表示」を出さない。
- MFA の有効期限が表示中に切れる: 次の API 呼び出しで `mfa_required` を受けて検証画面へ移る(入力中の検索 email は破棄される)。

## セキュリティとプライバシー

- 収集・表示データ: マスク済み email、公開 ID、状態、件数、失敗コード。外部送信なし。
- ログ禁止データ: 検索 email、MFA コード、API の本文。画面で `console` を使わない。
- 脅威と対策:
  - 存在の秘匿・権限昇格: layout が `authorizeAdmin` で判定し、Member は通常の 404。データは API が再判定する。
  - 総当たり: 試行制御は API(5 回/15 分ロック)。画面は失敗のたびに入力を消し、ロック中の案内を出す。
  - XSS: すべて React のエスケープで描画。`dangerouslySetInnerHTML` を使わない。
  - CSRF: 変更系は `POST /admin/mfa/verify` のみで、server の Origin 検証に依存する。
  - 情報の残存: email を URL/storage に残さない、`gcTime: 0`、`noindex`、`Cache-Control: no-store`(API)。
  - open redirect: `next` は許可リストで `/admin` 配下に絞る。

## AI要件

N/A。

## 可観測性と運用

- ログ・メトリクス: 追加なし。操作の記録は API の監査ログが担う。
- Runbook: [admin-operations.md](../runbooks/admin-operations.md) の MFA の手順に画面の導線を追記する。
- 展開/ロールバック: Feature Flag 不要(Admin が作られるまで誰も使えない)。revert で戻る。

## テスト対応表

| 要件    | Unit                                                                                 | Integration | E2E                                    |
| ------- | ------------------------------------------------------------------------------------ | ----------- | -------------------------------------- |
| ADS-001 | `next` の絞り込み(許可リスト、`/admin/mfa`・外部 URL・`//` の拒否)、ガードの振り分け | N/A         | Member 404、未認証、MFA 未検証、無効化 |
| ADS-002 | エラー分類(403/429/404/その他)、入力が残らない                                       | N/A         | 成功/失敗/リカバリーコード             |
| ADS-003 | 有効期限の表示                                                                       | N/A         | トップの表示                           |
| ADS-004 | email 検証、結果表示(0/1 件)、クエリキー/URL に email を含まない                     | N/A         | 検索、マスク、URL に残らない           |
| ADS-005 | 件数・ラベルの表示                                                                   | N/A         | 概要、404                              |
| ADS-006 | 状態ラベル、日時書式(UTC)、絞り込み                                                  | N/A         | 失敗一覧、空状態                       |
| ADS-007 | 同上                                                                                 | N/A         | 空状態(失敗ジョブがない場合)           |
| ADS-008 | 日時書式の性質テスト、`mfa_required` 受信時の遷移先                                  | N/A         | 監査行の確認                           |

## 未決事項

なし。実装をブロックしない事項:

- 失敗一覧のユーザー公開 ID から概要へ移る導線は、リンクのみで十分と判断した。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-10
Reviewed by: —

| Gate                 | Result | Evidence                                                                   |
| -------------------- | ------ | -------------------------------------------------------------------------- |
| Product              | Pass   | 目的、成功指標、範囲/対象外。ロードマップ T-403                            |
| Specification        | Pass   | ADS-001〜008、ADS-INV-001〜006、状態遷移、受け入れ基準                     |
| Domain and Time      | Pass   | 判定は API/Application(ADS-INV-001)。時刻は UTC 固定書式で表示(ADS-008)    |
| API and Data         | N/A    | 新規 API・DB 変更なし(minimal-admin.md の API を使用)                      |
| Security and Privacy | Pass   | セキュリティ節(存在の秘匿、総当たり、XSS、CSRF、open redirect、情報の残存) |
| AI                   | N/A    | AI を利用しないため                                                        |
| Testing              | Pass   | テスト対応表                                                               |
| Operations           | Pass   | 可観測性と運用節                                                           |
| Planning             | Pass   | [../plans/minimal-admin.md](../plans/minimal-admin.md)(PR-B の手順 9〜12)  |

### 受容リスク

- 画面側の Admin 判定は描画前の 1 回(layout)で、同一 layout 配下の client 遷移では再実行されない(ADR-010 の既知の制約)。権限の失効は次の API 呼び出しの `404`/`403` が担う。
- 30 分の MFA 期限は表示中に切れうる。切れた後の最初の API 呼び出しで検証画面へ移る。

### 未決事項

なし
