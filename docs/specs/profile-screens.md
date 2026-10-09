# オンボーディングとプロフィール画面 Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-09
変更区分: Standard
ロードマップ項目: T-213

## 目的

T-102 の `GET/PATCH /api/v1/me` を画面として提供する。新規 Member が初回ログイン直後に表示名とタイムゾーンを設定してから他の画面を使い始められるようにし(オンボーディング)、その後もプロフィールを編集できるようにする。タイムゾーンは習慣の「今日」の基準になるため、初回に必ず明示設定させる。基盤は [web-ui-foundation.md](web-ui-foundation.md)、認証画面は [auth-screens.md](auth-screens.md)、API の振る舞いは [user-profile.md](user-profile.md) に従う。

## 成功指標

- 新規 Member は login 後に `/onboarding` へ誘導され、表示名とタイムゾーンを保存すると `/today` へ進める(E2E)。
- オンボーディング未完了の Member は、保護画面(`/today` 等)を開いても `/onboarding` へ戻される(E2E)。
- 他ユーザーのプロフィールは画面からも API からも取得・更新できない(E2E)。
- タイムゾーンの不正値は保存されず、固定の文言で表示される(Unit、E2E)。
- フォームは keyboard だけで操作でき、エラーが項目と要約の両方で伝わる(E2E)。

## 範囲

- 画面: `/onboarding`(初回設定)、`/profile`(閲覧・編集)。
- オンボーディング完了の判定(`displayName` が `null` でないこと)と、未完了時の誘導(`(app)/(onboarded)` layout)。
- 編集項目: 表示名、タイムゾーン、週の開始曜日。
- ブラウザのタイムゾーンを初期選択として提案する(ユーザーが変更可能)。
- ナビゲーションへ「プロフィール」を追加。
- 文書: 本 Spec、Plan、`docs/09`。

## 対象外

- `locale` の編集 UI。UI は日本語のみで、選択肢を出しても効果がないため出さない(多言語化は P1 未決。API は `locale` を保持したまま変更しない)。
- email・パスワードの変更、アカウント削除・エクスポート(T-404)。
- 新規 API・DB の変更(Migration なし)、rate limit。
- タイムゾーン変更に伴う過去データの再計算(T-201 以降のルール。本タスクは値の保存のみ)。
- 表示名の画面上での利用(ヘッダーの挨拶等)。

## アクターと前提条件

| アクター                       | 前提条件                                                 |
| ------------------------------ | -------------------------------------------------------- |
| Member(オンボーディング未完了) | login 済み、プロフィールの `displayName` が `null`       |
| Member(オンボーディング完了)   | login 済み、`displayName` が設定済み                     |
| Guest                          | `/onboarding`・`/profile` は `/login?next=…` へ redirect |

## 機能要件

### PFS-001 オンボーディングの判定と誘導

- オンボーディング完了とは、プロフィールの `displayName` が `null` でないこと(PROF-006)。判定は Application の関数 1 箇所に置き、Presentation で再実装しない。
- 保護画面のうち `(app)/(onboarded)` 配下(`/today`、`/profile`)は、未完了なら `/onboarding` へ redirect し、子を描画しない。`/onboarding` は `(onboarded)` の外に置く。
- 完了済みの Member が `/onboarding` を開くと `/today` へ redirect する。
- 判定は server(layout)で毎回、DB のプロフィールから行う。client の記憶に依存しない。

### PFS-002 オンボーディング画面(`/onboarding`)

- 入力: 表示名(必須)、タイムゾーン。保存で `PATCH /api/v1/me`(`displayName`、`timezone`)を送る。
- タイムゾーンの初期値は、ブラウザの `Intl.DateTimeFormat().resolvedOptions().timeZone` が選択肢に含まれていればそれ、なければ現在のプロフィール値(既定 `Asia/Tokyo`)。ユーザーが変更済みの場合は上書きしない。
- 成功したら `/today` へ遷移する(`router.replace`)。`["me"]` の query cache を更新する。
- 画面の説明で、タイムゾーンが「今日」の判定に使われることを伝える。

### PFS-003 プロフィール画面(`/profile`)

- 現在のプロフィール(表示名、タイムゾーン、週の開始曜日)を取得して入力欄に表示し、編集して保存できる。変更がないときは保存ボタンを無効にしない(冪等。常に送れる)。
- 保存は変更した項目だけでなく 3 項目すべてを `PATCH` する(単純化。partial update の仕様に反しない)。
- 成功したら「保存しました」の状態表示(`role="status"`)を出す。cache を更新する。
- 取得中は `loading`、取得失敗は `error`(再試行ボタン)、`401` は共通処理で `/login` へ。

### PFS-004 入力検証と表示

- 表示名: 前後の空白を除いて空なら「入力してください」、50 文字(code point)超は「50文字以内」。文字種の検証(制御文字・双方向制御文字)は server が判定し、`422` の `fieldErrors.displayName` を受けたら固定の文言で表示する。
- タイムゾーン: 選択肢(`<select>`)から選ぶ。選択肢は server が `Intl.supportedValuesOf("timeZone")` と `UTC` と現在値から作る。選択肢にない値が送られても server が `422`(`fieldErrors.timezone`)で拒否し、画面は固定の文言を出す。
- 週の開始曜日: 日曜〜土曜(0〜6)の選択。
- server の `message`/`fieldErrors` の文字列は描画せず、キーから固定の文言を選ぶ(WUI-INV-003)。
- エラーは項目直下とフォーム上部の要約の両方に出し、送信失敗時に要約へフォーカスする(AUI-001 と同じ部品)。

### PFS-005 ナビゲーション

- ナビゲーションに「プロフィール」(`/profile`)を追加する。

## 業務ルールと不変条件

- PFS-INV-001(所有者限定): 画面は `GET/PATCH /api/v1/me` だけを使い、対象ユーザーを指定する手段を持たない。他ユーザーの情報を取得・表示しない。
- PFS-INV-002(判定の一元化): オンボーディング完了の定義は Application の `hasCompletedOnboarding` のみ。
- PFS-INV-003(server 文言の非描画): AUI-INV-002 と同じ。
- PFS-INV-004(業務ロジックを持たない): 表示名の文字種、タイムゾーンの妥当性は server(Domain)が判定する。client の検証は必須と上限の目安のみ。
- PFS-INV-005(個人情報の非ログ): 表示名・タイムゾーンをログ・URL・storage に出さない。

## 状態遷移

| 現在の状態 | 操作                     | 次の状態                  | 拒否される条件  |
| ---------- | ------------------------ | ------------------------- | --------------- |
| 未完了     | `(onboarded)` 配下を開く | `/onboarding` へ redirect | なし            |
| 未完了     | onboarding を保存        | 完了、`/today`            | 検証違反(`422`) |
| 完了       | `/onboarding` を開く     | `/today` へ redirect      | なし            |
| 完了       | profile を保存           | 完了(更新)                | 検証違反(`422`) |
| Guest      | `/onboarding`/`/profile` | `/login?next=…`           | なし            |

## 受け入れ基準

```gherkin
Scenario: 新規 Member は初回ログインでオンボーディングへ誘導される
  Given signup・メール確認を終えた Member
  When login する
  Then /onboarding が表示される
  When 表示名とタイムゾーンを保存する
  Then /today が表示される
  And GET /api/v1/me の displayName と timezone が保存した値である

Scenario: 未完了のまま他の保護画面を開くと戻される
  Given オンボーディング未完了の Member
  When /today または /profile を開く
  Then /onboarding へ redirect される

Scenario: 完了済みの Member は /onboarding から戻される
  Given オンボーディング完了済みの Member
  When /onboarding を開く
  Then /today へ redirect される

Scenario: プロフィールを編集する
  Given オンボーディング完了済みの Member
  When /profile で表示名・タイムゾーン・週の開始曜日を変更して保存する
  Then 「保存しました」が表示され、再読み込み後も変更が残る

Scenario: 不正な入力
  When 表示名を空にして保存する、または 51 文字の表示名を保存する
  Then request は送られず(または 422 で拒否され)、固定の文言のエラーが項目と要約に出る
  When server が timezone を 422 で拒否する
  Then 「タイムゾーンを選び直してください」の固定文言が出て、server の文言は出ない

Scenario: 他ユーザーのプロフィールは見えない
  Given Member A と Member B
  When それぞれが /profile を開く
  Then 各自の表示名だけが表示される

Scenario: 未認証
  When /onboarding または /profile を開く
  Then /login?next=… へ redirect される
```

## 認可マトリクス

| 操作                           | Guest | Member | Admin | 所有権ルール                   |
| ------------------------------ | ----: | -----: | ----: | ------------------------------ |
| `/onboarding`・`/profile` 閲覧 |    No |    Yes |   N/A | session の user のプロフィール |
| `GET/PATCH /api/v1/me`         |    No |    Yes |   N/A | T-102 のまま                   |

## APIとイベント

新規・変更なし。`GET /api/v1/me`、`PATCH /api/v1/me`(T-102)を消費する。`PATCH` はブラウザが付ける `Origin` が許可 Origin と一致する必要がある(T-102 の CSRF 対策)。Application に純粋関数 `hasCompletedOnboarding` を追加する(契約の変更ではない)。

## データとMigration

N/A。DB の変更はない。

## 失敗・境界ケース

- 取得失敗(5xx/通信): `error` 状態と再試行。保存中の二重送信は無効化する。
- 保存の `422`: 項目キーに対応する固定文言。対応する項目がなければフォーム全体の固定文言。
- `404`(user 不存在): 固定のエラー表示。
- ブラウザの timezone が選択肢にない/取得できない: 現在値のまま。
- 選択肢にない現在値(別名 ID 等): 現在値を選択肢へ追加して表示する。
- 別タブで先にオンボーディングを完了した場合: 保存は冪等で成功し、`/today` へ進む。
- layout の redirect は同一 layout 内の client 遷移で再実行されない。未完了のまま client 遷移しても API は動作し、データ保護には影響しない(UX のみ)。

## セキュリティとプライバシー

- 収集データ: 表示名、タイムゾーン、週の開始曜日(既存項目)。
- 外部送信データ: なし。
- ログ禁止データ: 表示名、タイムゾーン、body。
- 脅威と対策:
  - IDOR: 画面は `/me` のみ。対象指定の入力を持たない(E2E で 2 ユーザーを確認)。
  - XSS: 表示名は React のエスケープで描画し、`dangerouslySetInnerHTML` を使わない。E2E で HTML 文字列を含む表示名が文字として表示されることを確認する。
  - CSRF: `PATCH` は同一 origin の fetch で `Origin` が付き、server が検証する。
  - 入力サイズ: client は 50 文字(目安)で止め、server が最終判定。

## AI要件

N/A。

## 可観測性と運用

- ログ: 追加なし。
- メトリクス/アラート: N/A。
- Runbook: 追加なし。
- 展開/ロールバック: Feature Flag 不要。問題があれば revert。既存の `/today` は `(onboarded)` 配下へ移るが URL は変わらない。

## テスト対応表

| 要件    | Unit                                                                         | Integration | E2E                                             |
| ------- | ---------------------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| PFS-001 | `hasCompletedOnboarding`(null/設定済み/空白は不可の入力は server 側)、ガード | N/A         | 未完了の誘導、完了済みの `/onboarding` redirect |
| PFS-002 | タイムゾーン選択肢の構築(性質テスト)、初期値の決定                           | N/A         | オンボーディング保存 → `/today`                 |
| PFS-003 | 保存 body の組み立て                                                         | N/A         | 編集 → 再読み込み後も保持、保存メッセージ       |
| PFS-004 | 表示名の検証(code point 境界)、`fieldErrors` → 固定文言                      | N/A         | 空・51 文字・422 の固定文言、HTML 文字列の表示  |
| PFS-005 | nav 設定の整合(既存テスト)                                                   | N/A         | ナビゲーションの現在地                          |
| INV-001 | N/A                                                                          | N/A         | 2 ユーザーの `/profile` 分離                    |

## 未決事項

なし。次は実装中に確認する項目で、実装を左右しない。

- `locale` の UI は多言語化(P1)の決定後に追加する。
- ヘッダーでの表示名の表示は、画面が増える T-214 以降で再検討する。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-09
Reviewed by: —

| Gate                 | Result | Evidence                                                                                        |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| Product              | Pass   | 目的、成功指標、範囲/対象外。ロードマップ T-213(Phase 2.5)                                      |
| Specification        | Pass   | PFS-001〜005、PFS-INV-001〜005、状態遷移、受け入れ基準                                          |
| Domain and Time      | Pass   | オンボーディング完了の定義を Application へ一元化(PFS-INV-002)。timezone の検証は Domain(T-102) |
| API and Data         | N/A    | 新規 API・DB 変更なし。既存 API の消費側                                                        |
| Security and Privacy | Pass   | セキュリティとプライバシー節(IDOR、XSS、CSRF)                                                   |
| AI                   | N/A    | AI を利用しないため                                                                             |
| Testing              | Pass   | テスト対応表                                                                                    |
| Operations           | Pass   | 可観測性と運用節                                                                                |
| Planning             | Pass   | [../plans/profile-screens.md](../plans/profile-screens.md)                                      |

### 受容リスク

- layout の redirect は同一 layout 内の client 遷移で再実行されない(UX のみ。データは API が保護)。

### 未決事項

なし
