# 認証画面 Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-09
変更区分: Standard
ロードマップ項目: T-212

## 目的

T-101 の認証 API(signup、メール確認、login、logout、password reset)を、ブラウザで操作できる画面として提供する。利用者がアカウントを作り、確認し、ログインし、パスワードを再設定できるようにしつつ、失敗時の文言でアカウントの有無を漏らさない。T-211 で先送りした「遷移元への復帰(`next`)」と「認証済みユーザーの `/login` の扱い」もここで確定する。UI 基盤の方式は [ADR-010](../adr/ADR-010-web-ui-stack.md)、認証の振る舞いは [auth-adapter.md](auth-adapter.md)、共通基盤は [web-ui-foundation.md](web-ui-foundation.md) に従う。

## 成功指標

- signup → メール確認 → login → logout、および password reset の一連を、UI だけで完了できる(E2E)。
- login、signup、メール再送、password reset 要求のいずれの画面でも、アカウントの有無・確認済み状態・lockout を区別できる文言や表示差がない(Unit、E2E)。
- `next` に外部 origin・protocol-relative URL・`/api/` 等を指定しても、遷移先は同一 origin の安全な path に限られる(性質テスト、E2E)。
- フォームは keyboard だけで操作でき、エラーはフィールドと要約の両方で、色だけに依存せず伝わる(E2E)。
- 二重送信で signup・メール再送が重複して要求されない(Unit、E2E)。

## 範囲

- 画面: `/signup`、`/login`、`/verify-email`(token あり: 確認、token なし: 確認メールの再送)、`/password-reset`(要求)、`/password-reset/confirm`(新パスワード設定)。
- ログアウト操作(保護画面のヘッダー)。
- 遷移元への復帰(`next`)と、session 失効時の案内。
- 認証済みユーザーが `/login`・`/signup`・`/password-reset` を開いたときの `/today` への redirect。
- フォーム共通部品(`TextField`、エラー要約)と、入力の最小限の検証(必須・上限・形式の目安)。
- Auth.js 標準 endpoint を呼ぶ client(`lib/auth`)。
- 文書: 本 Spec、Plan、`docs/09`。

## 対象外

- 新規 API・DB の変更(Migration なし)、rate limit/lockout の変更(T-101 の AUTH-010 のまま)。
- パスワード強度メーター、「パスワードを表示」切り替え、パスワードマネージャー連携以外の補助機能、OAuth、MFA。
- 表示名・timezone の入力(オンボーディングは T-213)。signup 後の遷移先は login までで、プロフィール設定は T-213。
- ログイン状態の維持期間の選択(「ログインしたままにする」)。session 期間は T-101 の `SESSION_TTL_MS` のまま。
- 多言語化、メール本文の変更。

## アクターと前提条件

| アクター               | 前提条件                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| Guest(未認証)          | なし。認証画面をすべて利用できる                                                |
| Member(email 未確認)   | signup 済み。確認メールの token で `/verify-email` を完了する                   |
| Member(email 確認済み) | login できる。認証画面(login/signup/password-reset 要求)は `/today` へ redirect |

## 機能要件

### AUI-001 画面とフォーム共通

- 各フォームは `<form>` で、項目ごとに `<label>` を持ち、`autocomplete`(email: `username`/`email`、password: `current-password`/`new-password`)と適切な `type`/`inputMode` を設定する(WCAG 1.3.5)。
- 送信中は送信ボタンを無効化し、完了まで再送できない(二重送信防止)。送信中であることを `aria-busy` または状態表示で伝える。
- エラーは(a)フォーム上部のエラー要約(`role="alert"`、送信失敗時にフォーカスを移す)と(b)該当項目の直下のメッセージ(`aria-describedby`、`aria-invalid`)で示す。要約から該当項目へ移動できるリンクを持つ。
- 表示する文言はすべて client が持つ固定の文言とする(WUI-INV-003)。server の `message` と `fieldErrors` の文字列は描画せず、`fieldErrors` のキー(どの項目か)だけを使って固定の文言を選ぶ。
- password の入力値は state にのみ保持し、URL・storage・ログに出さない。送信成功・失敗後に password 欄を空にする。

### AUI-002 Signup(`/signup`)

- 入力: email、password。password 欄の近くに「8 文字以上 128 文字以内」を常時表示する(AUTH-002 の目安。判定は server)。
- 送信前の検証(UX のみ): email が空、`@` を含まない、254 文字超。password が空、128 文字超。その場合は request を送らずフィールドエラーを出す。password の最小文字数や制御文字の判定は server に任せ、`422`(`fieldErrors` に `password`)を受けたら固定文言で表示する。
- `202` を受けたら、登録の有無に依らない固定の完了表示「確認メールを送信しました。届いていない場合は迷惑メールフォルダーもご確認ください。」を出す。入力した email は完了表示に含めない。完了表示からメール再送(`/verify-email`)と login へ移動できる。
- 既に登録済みの email でも同じ表示になる(server が `202`)。UI は区別しない。

### AUI-003 メール確認(`/verify-email`)

- `token` クエリがある場合: 「メールアドレスを確認する」ボタンを表示する。ボタンを押すと `POST /api/v1/auth/verify-email` を送る(リンクの先読みで token を消費しないよう、自動送信しない)。成功(`200`)で「確認が完了しました」と login への導線を出す。`400`(`invalid_or_expired_token`)は理由を区別せず「リンクが無効、または期限が切れています」と再送への導線を出す。
- `token` クエリがない場合、または再送への導線から開いた場合: email 入力と「確認メールを再送する」。`POST /api/v1/auth/verify-email/resend` が `202` なら、有無に依らない固定の完了表示を出す。
- token は URL からのみ読み、画面に表示しない。確認ボタンの送信後、URL から token を取り除く(履歴・リファラへの残存を減らす)。

### AUI-004 Login(`/login`)

- 入力: email、password。`next` クエリ(任意)を受ける。
- 送信は Auth.js の credentials callback(`lib/auth` 経由)を使う。結果は session の有効性(`/api/auth/session` が user を返すか)で判定し、失敗の種類(不存在・不一致・未確認・lockout)を区別しない。
- 失敗時は常に同一の固定文言「メールアドレスまたはパスワードが正しくないか、メールアドレスの確認が完了していません。」を出す。この文言には確認メール再送(`/verify-email`)へのリンクを添えるが、リンクは常に表示し、アカウントの状態で出し分けない。
- 成功時は `next`(AUI-007 の検証後)があればそこへ、なければ `/today` へ `router.replace` で遷移する。
- `reason=session_expired` クエリがある場合は「ログインの有効期限が切れました。もう一度ログインしてください。」を表示する。値は固定の列挙のみ解釈し、他の値は無視する。

### AUI-005 Password reset 要求(`/password-reset`)

- 入力: email。`POST /api/v1/auth/password-reset` が `202` なら、有無に依らない固定の完了表示「入力されたメールアドレス宛に、再設定の案内を送信しました(登録がある場合)。」を出す。

### AUI-006 Password reset 確定(`/password-reset/confirm`)

- `token` クエリからリンクを開く。入力: 新しい password(`autocomplete="new-password"`)。
- 成功(`200`)で「パスワードを再設定しました。ログインしてください」と login への導線を出す(server が既存 session を失効させる。AUTH-008)。
- `400`(`invalid_or_expired_token`)は「リンクが無効、または期限が切れています」と再設定の再要求(`/password-reset`)への導線を出す。`422`(`newPassword`)は固定文言のフィールドエラー。
- token が無い場合は再設定の再要求への導線のみを出し、request を送らない。
- token は画面に表示しない。送信後に URL から取り除く。

### AUI-007 遷移元への復帰(`next`)

- 保護画面(`(app)`)が未認証で開かれたとき、`/login?next=<元の path とクエリ>` へ redirect する。元の path は proxy が付与する request header(`x-pathname`)から得る。
- `next` は `sanitizeNextPath` で検証してから使う。許可するのは、`/` で始まり、`//` や `\` で始まらず、制御文字・空白・`:` を含むスキームを持たず、`/api/` と認証画面(`/login`、`/signup`、`/verify-email`、`/password-reset`)で始まらない同一 origin の path のみ。不正な値は無視して `/today` にする。
- proxy は `x-pathname` を常に上書きして付与する(client が指定した値を信用しない)。proxy は認証判定を行わない(保護は引き続き `(app)` layout)。
- session 失効で API が `401` を返した場合、client は `/login?next=<現在の path>&reason=session_expired` へ遷移する。

### AUI-008 Logout

- 保護画面のヘッダーに「ログアウト」ボタンを置く。押すと Auth.js の signout(CSRF token 付き)を呼び、成功したら query cache を破棄して `/login` へ遷移する。
- 失敗(network 等)でもキャッシュは破棄せず、固定のエラー表示を出して再試行できる。

### AUI-009 認証済みユーザーの扱い

- 認証済みユーザーが `/login`、`/signup`、`/password-reset` を開くと `/today` へ redirect する(layout で DB session を検証)。
- `/verify-email`、`/password-reset/confirm` は認証状態に依らず表示できる(メールのリンクを別の端末・ブラウザで開く場合があるため)。

## 業務ルールと不変条件

- AUI-INV-001(列挙の非漏洩): login・signup・メール再送・password reset 要求の画面は、アカウントの有無・確認済み状態・lockout によって文言・要素・遷移・応答時間に依存する表示差を持たない。表示は HTTP status と `fieldErrors` のキーだけで決まる。
- AUI-INV-002(server 文言の非描画): server の `message`・`fieldErrors` の文字列を描画しない(WUI-INV-003)。
- AUI-INV-003(安全な遷移先): 画面遷移の宛先は固定の内部 path か `sanitizeNextPath` を通った値のみである。外部 origin へは遷移しない。
- AUI-INV-004(機微値の非残存): password と token は URL(送信後)・storage・ログ・error 文言・画面に残さない。
- AUI-INV-005(業務ロジックを持たない): password policy・rate limit・token の有効性は server が判定する。UI の検証は必須・上限・形式の目安に限る。
- AUI-INV-006(DB session が正): ログイン状態は Auth.js の session 応答(DB session 由来)で判定し、Cookie の存在や client の記憶で判定しない。

## 状態遷移

| 現在の状態           | 操作                      | 次の状態                               | 拒否される条件                          |
| -------------------- | ------------------------- | -------------------------------------- | --------------------------------------- |
| Guest                | signup 送信               | 完了表示(確認メール案内)               | 入力検証失敗(request を送らない)、`422` |
| Guest                | verify-email の確認ボタン | 確認完了                               | token 無効/期限切れ(`400`)              |
| Guest                | login 送信                | `next` または `/today`                 | 認証失敗(理由を区別しない)              |
| Guest                | password reset 要求       | 完了表示                               | 入力検証失敗                            |
| Guest                | password reset 確定       | 再設定完了                             | token 無効/期限切れ(`400`)、`422`       |
| Member               | logout                    | `/login`                               | 通信失敗(再試行できる)                  |
| Member               | `/login` 等を開く         | `/today` へ redirect                   | なし                                    |
| Member(session 失効) | API 呼び出し(`401`)       | `/login?next=…&reason=session_expired` | なし                                    |

## 受け入れ基準

```gherkin
Scenario: signup からログアウトまでの一連
  Given 未登録の架空ユーザー
  When /signup で email と password を送信する
  Then 固定の完了表示が出て、確認メールが Mailpit に届く
  When メールのリンクを開き「メールアドレスを確認する」を押す
  Then 確認完了が表示される
  When /login で同じ email と password を送信する
  Then /today が表示される
  When 「ログアウト」を押す
  Then /login が表示され、/today を開くと /login へ redirect される

Scenario: ログイン失敗は理由を区別しない
  Given 登録済み・確認済みのユーザー A と、未登録の email B
  When A の誤った password、未登録の B、確認前のユーザーで login する
  Then すべて同一の固定文言が表示され、ページ構成も同じである

Scenario: signup は登録済み email でも同じ表示
  Given 既に登録済みの email
  When その email で signup する
  Then 新規と同一の完了表示が出る

Scenario: password reset の一連
  Given 確認済みのユーザー
  When /password-reset で email を送信し、メールのリンクから新しい password を設定する
  Then 再設定完了が表示され、古い password での login は拒否され、新しい password で login できる
  And 同じリンクの再利用は「無効、または期限切れ」と表示される

Scenario: 遷移元へ復帰する
  Given 未認証のブラウザ
  When /today を開く
  Then /login?next=%2Ftoday へ redirect される
  When login に成功する
  Then /today が表示される

Scenario: 不正な next は無視する
  Given /login?next=//evil.example または next=https://evil.example
  When login に成功する
  Then 遷移先は /today である

Scenario: 認証済みユーザーは認証画面から戻される
  Given ログイン済みのユーザー
  When /login を開く
  Then /today へ redirect される

Scenario: 入力エラーの伝え方
  When email 欄を空のまま signup を送信する
  Then request は送られず、エラー要約にフォーカスが移り、email 欄は aria-invalid と説明文を持つ

Scenario: token が無効なメール確認
  When 不正な token で /verify-email を開き確認ボタンを押す
  Then 「無効、または期限が切れています」と再送への導線が表示される
```

## 認可マトリクス

| 操作                                 | Guest | Member | Admin | 所有権ルール             |
| ------------------------------------ | ----: | -----: | ----: | ------------------------ |
| signup / login / password reset 画面 |   Yes |     No |   N/A | Member は `/today` へ    |
| verify-email / reset confirm 画面    |   Yes |    Yes |   N/A | token が認可情報を兼ねる |
| logout                               |    No |    Yes |   N/A | 自分の session のみ      |
| `/api/*`                             |  既存 |   既存 |   N/A | T-101 の仕様のまま       |

## APIとイベント

新規・変更なし。T-101 の次を消費する: `POST /api/v1/auth/signup`、`verify-email`、`verify-email/resend`、`password-reset`、`password-reset/confirm`、および Auth.js 標準の `GET /api/auth/csrf`、`POST /api/auth/callback/credentials`(`json=true`)、`GET /api/auth/session`、`POST /api/auth/signout`。

Auth.js 標準 endpoint は `/api/v1` の例外([ADR-009](../adr/ADR-009-api-style.md))であり、型付き API client(`apiRequest`)の対象外(`/api/v1/` のみ許可する不変条件を保つため)。`lib/auth/auth-client.ts` に集約し、画面から直接呼ばない。proxy(`src/proxy.ts`)は `x-pathname` request header を付与するだけで、API には適用しない(matcher で `/api` を除外)。

## データとMigration

N/A。DB の変更はない。

## 失敗・境界ケース

- 通信失敗・timeout: 固定の「通信に失敗しました。時間をおいてもう一度お試しください。」をエラー要約に出し、再送できる。入力値(password 以外)は保持する。
- `422`: `fieldErrors` のキーに対応する項目へ固定のエラーを出す。未知のキーはフォーム全体の固定エラーにする。
- `429`/rate limit/lockout: T-101 は区別しない応答(`202`/generic error)を返すため UI も区別しない。
- 二重クリック・Enter 連打: 送信中は無効化し、request は 1 回。
- Auth.js の callback の応答後に session が取れない: 認証失敗と区別できないため、login 失敗と同一の固定文言を使う(通信自体の失敗=fetch の例外だけを通信失敗の文言にする)。
- `next` が非常に長い・不正にエンコードされている: 無視して `/today`。
- 別端末でメールのリンクを開く: `/verify-email`・`/password-reset/confirm` は認証状態に依らず動作する。
- password reset 確定後は既存 session が失効する(AUTH-008)ため、別タブの保護画面は次の API 呼び出しの `401` で login に戻る。

## セキュリティとプライバシー

- 収集データ: email、password(送信のみ。保存はしない)。
- 外部送信データ: なし。
- ログ禁止データ: email、password、token、session、`next` の値。client は `console` に出力しない。
- 脅威と対策:
  - アカウント列挙: AUI-INV-001。文言・要素・遷移を固定にし、E2E で比較する。
  - Open redirect: `sanitizeNextPath`(許可リスト方式)と `x-pathname` の上書き。性質テストと敵対的入力の Unit。
  - CSRF: 未認証の `/api/v1/auth/*` は session を使わないため CSRF の対象外。login/logout は Auth.js の CSRF token(double submit cookie)で保護される。client は毎回 `/api/auth/csrf` で取得した値を送る。session を伴う `/api/v1` の変更系は既存の Origin 検証のまま。
  - XSS: React のエスケープ、`dangerouslySetInnerHTML` 不使用、server 文言を描画しない。
  - token の漏えい: 画面に表示しない、送信後に URL から除去、メールのリンクの GET では消費しない(ボタンの POST で消費)。ただしリンクを開いた時点の URL に token が含まれるため、`Referrer-Policy: no-referrer` を認証 token ページに設定する。
  - クリックジャッキング: 認証画面に `X-Frame-Options: DENY`/CSP `frame-ancestors 'none'` を付与する(`next.config.ts` の headers。全 route に適用)。
  - brute force/credential stuffing: server の AUTH-010 に任せる。UI は二重送信を防ぐのみ。
  - パスワードマネージャー: 適切な `autocomplete` を設定し、貼り付けを禁止しない。

## AI要件

N/A。AI を利用しない。

## 可観測性と運用

- ログ: 新しいログは追加しない(email・token を含めない)。
- メトリクス/アラート: N/A(インフラ未着手)。server 側の login 失敗率等は T-101 の仕様のまま。
- Runbook: 追加なし。ローカルの確認は Mailpit(`pnpm mail:up`)。
- 展開/ロールバック: Feature Flag は不要。問題があれば revert する。`/login` の暫定表示を置き換えるため、公開前は画面なしの期間はない。

## テスト対応表

| 要件        | Unit                                                                                  | Integration | E2E                                                    |
| ----------- | ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| AUI-001     | `TextField`/エラー要約の属性(label、`aria-invalid`、`aria-describedby`、`role=alert`) | N/A         | エラー要約へのフォーカス、keyboard 操作                |
| AUI-002     | 入力検証(空・上限・形式の目安)、`fieldErrors` → 固定文言の対応                        | N/A         | signup 完了表示、登録済み email でも同一表示           |
| AUI-003     | 状態遷移(確認前/成功/無効/再送)の reducer 相当の純粋関数                              | N/A         | メールのリンク → 確認、無効 token、再送                |
| AUI-004     | auth client(csrf 取得、credentials callback、session 判定、失敗の同一化)              | N/A         | login 成功/失敗3種の同一文言、`next` 復帰              |
| AUI-005/006 | 入力検証、`400`/`422` の分類                                                          | N/A         | password reset の一連、リンク再利用の拒否              |
| AUI-007     | `sanitizeNextPath`(性質テスト+敵対的入力)、`x-pathname` を付ける proxy の関数         | N/A         | 未認証 → `next` 付き redirect、不正な next は `/today` |
| AUI-008     | auth client の signout                                                                | N/A         | logout 後に `/today` が保護され、旧 cookie が無効      |
| AUI-009     | N/A                                                                                   | N/A         | 認証済みで `/login` → `/today`                         |
| AUI-INV-001 | 失敗文言が単一の定数であること                                                        | N/A         | 失敗3種の本文が一致                                    |
| AUI-INV-004 | 送信後の URL 整形(token 除去)                                                         | N/A         | 送信後の URL に token がない                           |

## 未決事項

なし。次は実装中に確認する項目で、実装を左右しない。

- 認証 token ページのセキュリティヘッダー(`Referrer-Policy`、`frame-ancestors`)は `next.config.ts` の headers で全 route に付与する。CSP 全体の設計は T-501 以降(`docs/08-security.md`)。
- ログアウトボタンの配置はヘッダーの右端とし、項目が増える T-213 以降で再検討する。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-09
Reviewed by: —

| Gate                 | Result | Evidence                                                                          |
| -------------------- | ------ | --------------------------------------------------------------------------------- |
| Product              | Pass   | 目的、成功指標、範囲/対象外。ロードマップ T-212(Phase 2.5)                        |
| Specification        | Pass   | AUI-001〜AUI-009、AUI-INV-001〜006、状態遷移、受け入れ基準                        |
| Domain and Time      | N/A    | 業務ルール・日付を扱わない。二重送信は UI の無効化で防ぎ、冪等性は server(T-101)  |
| API and Data         | N/A    | 新規 API・DB 変更なし。既存 API の消費側であることを確認済み                      |
| Security and Privacy | Pass   | セキュリティとプライバシー節(列挙、open redirect、CSRF、token 取り扱い、ヘッダー) |
| AI                   | N/A    | AI を利用しないため                                                               |
| Testing              | Pass   | テスト対応表、Mailpit 実物での E2E、fixture は架空データのみ                      |
| Operations           | Pass   | 可観測性と運用節(revert、ログに機微情報を出さない)                                |
| Planning             | Pass   | [../plans/auth-screens.md](../plans/auth-screens.md)                              |

### 受容リスク

- メールのリンクを開いた時点で token が URL にある間、ブラウザ履歴・拡張機能に残りうる。送信後に URL から除去し、`Referrer-Policy: no-referrer` と単回使用・短 TTL(T-101)で緩和する。
- login の成功判定に session 取得(`/api/auth/session`)の追加 request が必要で、1 往復増える。

### 未決事項

なし
