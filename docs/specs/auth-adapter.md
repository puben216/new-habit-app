# Auth Adapter and Session Spec

Status: Ready
Owner: TBD
Last updated: 2026-09-17
Change classification: Standard
Roadmap Task: T-101

## Goal

メールアドレス + パスワードによる登録・ログイン・ログアウト・パスワード再設定(01-product-requirements.md 機能要件 1)を提供する。技術選定(Auth.js、DB session、argon2id)は [ADR-001](../adr/ADR-001-authentication.md) で決定済みであり、本 Spec はその上で満たすべき振る舞いと不変条件を定義する。T-102 以降のすべての認可付き機能は、本 Spec が定義する session からの actor user ID 取得のみに依拠する。

## Success Metrics

- 登録ユーザーが email verification を経て自分のアカウントで継続的にログインできる(認証起因の問い合わせ・ロックアウトの誤検知が実運用で許容範囲に収まる)。
- 認証情報の漏洩・総当たり攻撃・アカウント推測が本 Spec の Business Rules と Security and Privacy 節で定義した対策により防止されている。
- 以降の全機能(T-102〜)が、本 Spec の Functional Requirements・API 契約をそのまま再利用でき、認証周りの再設計が不要である。

品質ゲート(`lint:boundaries`、E2E green 等)は [definition-of-done.md](../governance/definition-of-done.md) が担う達成条件であり、本 Success Metrics には含めない。

## Scope

- Credentials(email + password)によるログイン手段の提供。
- signup、email verification、login、logout。
- password reset の request/confirm。
- login への rate limit/lockout(email 単位。外部から観測される挙動として定義。保存方式は Plan)。
- session の発行・rotation・revocation(外部から観測される挙動として定義。DB session である点は [ADR-001](../adr/ADR-001-authentication.md) の決定を参照)。
- signup/verification/reset request 全般での account enumeration 対策。

## Out of Scope

- Google/GitHub OAuth。当初「補助手段」として計画していたが、[ADR-001](../adr/ADR-001-authentication.md)(2026-09-16 改訂)により MVP スコープから外した。将来追加する場合は別途 Spec を起こす(email 重複判定などを再設計する必要がある)。
- Admin role、admin 向け TOTP 2FA([ADR-001](../adr/ADR-001-authentication.md) は admin 向け管理画面自体が T-403 まで存在しないため、admin TOTP 2FA の実装は T-403 に含めると改訂済み)。
- User/Profile の表示名・タイムゾーン・通知設定管理(T-102)。
- 実 SES 送信統合、送信ドメイン確定(T-401、[ADR-005](../adr/ADR-005-email.md) follow-up)。本 Spec は「メールで届く」という振る舞いのみを要求し、配送実装は Plan/T-401 に委ねる。
- Habit 等の業務リソースへの認可適用(T-104 以降が個別に `actor user ID` を用いて実装する)。
- パスワード以外の認証要素(passkey 等)。
- IP アドレス単位の rate limit(email 単位のみを MVP スコープとする。将来必要になれば別 Spec で扱う)。
- 実装の内部構成(class、port、adapter、テーブル分割方式、transaction 境界)— [../plans/auth-adapter.md](../plans/auth-adapter.md) を参照。

## Actors and Preconditions

| Actor                  | Preconditions                 |
| ---------------------- | ----------------------------- |
| Guest(未認証)          | なし                          |
| Member(email 未確認)   | signup 成功済み、email 未確認 |
| Member(email 確認済み) | verification 成功済み         |

## Functional Requirements

### AUTH-001 Credentials signup

- email と password で新規登録できる。
- 同一 email での signup を繰り返しても、外部から見た応答(status/body/明白な処理時間差、AUTH-INV-002 参照)は初回と区別できない。
- password は本 Spec の password policy(AUTH-002)を満たさない場合、フィールド単位のエラーで拒否する。
- 成功時、verification のための通知が登録 email 宛に送られる(配送手段は Out of Scope)。

### AUTH-002 Password policy

- 最小 8 文字、最大 128 文字。文字数判定は先頭・末尾の空白を除いた(trim 後の)長さで行う。
- password は入力された文字列を変更せずハッシュ化・照合する。先頭・末尾の空白も password の一部として扱い、保存・照合時に取り除かない(文字数判定にのみ trim を用いる)。
- 制御文字(U+0000–U+001F、U+007F)を含む password は拒否する。
- 128 文字を超える入力はハッシュ計算前に拒否し、長大入力による処理コスト増大(DoS)を防ぐ。
- password には email や既知の脆弱パスワードリストとの一致チェックは MVP では行わない。

### AUTH-003 Email verification

- verification token は単回使用。同一 token での並行した複数検証リクエストがあっても、成功するのは最大 1 件のみであり、他は失敗として扱う(AUTH-INV-001 不変条件)。
- token には有効期限があり、期限切れの token は失敗として扱う。
- 検証成功時、当該 email が確認済み状態になる。
- 期限切れ/使用済み/不正な token の失敗理由は、外部から区別できない同一のエラーとして返す。

### AUTH-004 Verification 再送

- Member(email 未確認)は verification の再送を要求できる。
- 再送は rate limit の対象とし(AUTH-010)、短時間の連続要求で新しい email 配送が無制限に発生しないようにする。
- 再送された場合、直前に発行された未使用 token は無効化する(同時に有効な token は常に最大 1 件)。

### AUTH-005 Credentials login

- email + password が一致し、かつ email が確認済み(`email_verified_at` が設定済み)の場合のみログインを許可する。
- 認証失敗(email 不存在、password 不一致、email 未確認、lockout 中のいずれでも)は同一の generic error を返し、外部から失敗理由を区別できない。
- email が存在しない場合も、存在する場合と処理時間が明白に変わらないよう dummy の password hash 検証を実行する(AUTH-INV-002)。
- ログイン成功時、新しい session が発行される。

### AUTH-006 Logout

- 現在の session を失効させる。
- 失効後、当該 session を用いたリクエストは unauthenticated として扱われる。

### AUTH-007 Password reset request

- 登録済み email の有無にかかわらず、外部から見た応答は区別できない(AUTH-INV-002)。
- 登録済みの account であれば reset token が発行され通知される。該当 email の account が存在しない場合、実際には token は発行されない(応答は区別できない)。

### AUTH-008 Password reset confirm

- 有効な token と新しい password(AUTH-002 準拠)があれば password を更新する。同時に有効な token は常に最大 1 件のみ成功する(AUTH-INV-001)。
- 更新成功後、当該 user の既存 session をすべて失効させる。
- 期限切れ/使用済み/不正な token は拒否する。

### AUTH-009 Session validation

- 以降の全機能は session から actor user ID のみを取得し、認可判定に使う。
- 期限切れ/改ざんされた session は unauthenticated として扱う。

### AUTH-010 Rate limit/lockout

- 対象: signup、verification 再送、Credentials login、password reset request のそれぞれについて、同一 email 宛の直近 15 分間の試行を制限する(email 単位のみ)。
- 閾値: 直近 15 分間に 5 回失敗した場合、以後 15 分間は当該 email での試行を拒否する(lockout)。この値は運用実績に応じて調整可能な設定値として扱い、Plan で config 化する([10-decisions-and-open-questions.md](../10-decisions-and-open-questions.md) P2 参照)。
- 閾値超過時の外部挙動は、通常の失敗と区別できない generic error とする(lockout の存在自体を漏らさない)。
- rate limit 判定に使う試行履歴は、判定ウィンドウ(15 分)を超えた分を保持し続けない。保存方式・削除の実装は Plan で定義するが、削除自体は本 Spec の対象範囲内で行う(別 Issue に先送りしない)。

## Business Rules and Invariants

- パスワードは AUTH-002 のポリシーを満たさない限り受け付けない。平文パスワードを DB・ログ・telemetry に残さない。password の先頭・末尾の空白は除去せず、そのままハッシュ化・照合に使う(文字数判定にのみ trim を用いる)。
- verification token・reset token は常にハッシュ化して保存し、平文は発行直後の通知にのみ使う。
- AUTH-INV-001(token の atomic な単回使用): 同一の verification token または password reset token に対して並行して複数の検証/確定リクエストが行われても、成功するのは最大 1 件のみである。他はすべて失敗として扱う(二重使用防止)。token は使用後に再利用できない。
- AUTH-INV-002(account enumeration 対策): signup、verification 再送、Credentials login、password reset request は、対象 email の登録有無によって外部から観測可能な応答(status code、body)が変わらず、かつ明白な処理時間差を生じさせない。Credentials login は email 不存在時にも dummy の password hash 検証を実行し、DB 照会結果によって処理経路を分岐させない。
- email の一意性: `users.email_normalized` は account 全体で一意である(T-004 で追加済みの制約をそのまま利用する)。
- email 正規化: 前後の空白を除去し、local part・domain part をともに小文字化した文字列を照合・保存に用いる(大文字小文字を区別する email provider は実務上ごく少数であり、本 Spec では区別しない前提を置く)。Gmail 固有の dot 除去・plus タグ除去などの provider 固有の正規化は行わない。Unicode を含む email は Unicode 正規化(NFC)のみ行い、国際化ドメイン名(IDN)の punycode 変換は行わない。
- email が確認済みでない account は login できない。
- password reset の confirm は password の更新のみを行い、email 確認状態を変更しない。email 未確認のまま confirm を完了しても、その後の login にはあらためて email 確認が必要。
- password の更新(reset confirm)が成功した時点で、その user の既存 session はすべて失効する。
- 認証失敗のレスポンスは、失敗理由(アカウント不存在/password 不一致/email 未確認/lockout)によらず外部から区別不能な generic error にする。

## State Transitions

| Current                       | Action                    | Next                                          | Rejected when                                         |
| ----------------------------- | ------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| unauthenticated               | signup                    | pending_verification                          | email 形式不正、password policy 違反、rate limit 超過 |
| pending_verification          | verify email              | verified                                      | token 期限切れ/使用済み/不正                          |
| pending_verification          | request verification 再送 | pending_verification(新 token)                | rate limit 超過                                       |
| pending_verification          | login                     | (拒否)                                        | 常に拒否(email 未確認のため)                          |
| verified                      | login                     | authenticated session                         | password 不一致、lockout 中                           |
| authenticated                 | logout                    | unauthenticated                               | -                                                     |
| pending_verification/verified | request password reset    | reset token issued(外部応答は不変)            | rate limit 超過                                       |
| reset token issued            | confirm password reset    | password updated, token used, 全 session 失効 | token 期限切れ/使用済み/不正、policy 違反             |

## Acceptance Criteria

```gherkin
Scenario: Credentials signup and email verification
  Given メールアドレス "user@example.com" が未登録である
  When そのメールアドレスと policy を満たすパスワードで signup する
  Then pending_verification 状態の account が作成され、verification 通知が送られる

Scenario: 重複メールアドレスでの signup は情報を漏らさない
  Given メールアドレス "user@example.com" が既に登録済みである
  When 同じメールアドレスで signup する
  Then 新規登録時と区別できない応答が返り、新しい account は作成されない

Scenario: Credentials login の失敗は理由を区別しない
  Given 登録済みの Member が存在する
  When 誤ったパスワードでログインする
  Then アカウント不存在の場合と同一の generic error が返る

Scenario: email 未確認のアカウントはログインできない
  Given signup 直後で email 未確認の Member が存在する
  When 正しい email + password でログインを試みる
  Then パスワード不一致の場合と同一の generic error でログインが拒否される

Scenario: Password reset は単回使用トークンで完結する
  Given 有効な reset token を持つ Member が存在する
  When そのトークンで policy を満たす新しいパスワードを設定する
  Then パスワードが更新され、同じトークンでの再利用は拒否され、既存 session がすべて失効する

Scenario: 同一トークンへの並行リクエストは最大1件のみ成功する
  Given 有効な verification token が存在する
  When その token に対して同時に複数の検証リクエストが送られる
  Then 成功するのは 1 件のみであり、他はすべて失敗する(AUTH-INV-001)

Scenario: ログイン失敗が閾値を超えると一時的にロックされる
  Given 同一メールアドレスへの誤パスワードログインが閾値回数連続している
  When さらにログインを試みる
  Then 正しいパスワードであっても generic error で拒否される
```

## Authorization Matrix

| Operation              | Guest | Member (unverified) | Member (verified) | Ownership rule               |
| ---------------------- | ----: | ------------------: | ----------------: | ---------------------------- |
| signup                 |   Yes |                 N/A |               N/A | -                            |
| verify email / 再送    |   Yes |                 Yes |               N/A | 自分の token のみ有効        |
| login                  |   Yes |                  No |               Yes | email 確認済みアカウントのみ |
| logout                 |    No |                 Yes |               Yes | 自分の session のみ          |
| password reset request |   Yes |                 Yes |               Yes | -                            |
| password reset confirm |   Yes |                 Yes |               Yes | 自分の token のみ有効        |

Admin ロールは本 Spec の対象外(T-403)。

## API and Events

Base path は [05-api-and-ai-design.md](../05-api-and-ai-design.md) の `/api/v1` 方針に従う。Auth.js 標準 route(`GET/POST /api/auth/[...nextauth]`)は、外部ライブラリが規定する標準 endpoint であるため `/api/v1` の例外とする([ADR-009](../adr/ADR-009-api-style.md) の decision に基づく)。契約境界: この route は Auth.js の session/CSRF/signin/signout 管理に閉じ、本 Spec が独自定義する `/api/v1/auth/*` 以下の endpoint(signup、email verification、password reset)とは責務を分離する。

共通仕様: 本 Spec が独自定義する `/api/v1/auth/*` endpoint はすべて `Content-Type: application/json`、未知キーは拒否、エラーは Problem Details 形式(`code`, `message`, `fieldErrors`, `requestId`)。Auth.js 標準 route(`GET/POST /api/auth/[...nextauth]`)はこの共通仕様の対象外(Auth.js 標準の挙動に従う)。

### `POST /api/v1/auth/signup`

| 項目                 | 内容                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| 認証要否             | 不要                                                                                                           |
| 入力                 | `email`(string, 最大 254 文字, RFC 5322 準拠形式), `password`(AUTH-002 準拠)                                   |
| 正常応答             | `202 Accepted`(verification 通知を送った/送ろうとしたことのみを表し、account 作成有無は示さない。AUTH-INV-002) |
| バリデーションエラー | `422`、`fieldErrors` に `email`/`password` の違反理由                                                          |
| rate limit超過       | `202`(AUTH-INV-002 により成功時と区別しない。内部的には通知を送らない)                                         |
| 入力上限             | email 254 文字、password 128 文字                                                                              |

### `POST /api/v1/auth/verify-email`

| 項目     | 内容                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| 認証要否 | 不要(token が認可情報を兼ねる)                                                           |
| 入力     | `token`(string)                                                                          |
| 正常応答 | `200 OK`                                                                                 |
| エラー   | 期限切れ/使用済み/不正すべて `400`、`code: "invalid_or_expired_token"`(理由を区別しない) |
| 入力上限 | token 512 文字                                                                           |

### `POST /api/v1/auth/verify-email/resend`

| 項目           | 内容                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| 認証要否       | 不要                                                                       |
| 入力           | `email`                                                                    |
| 正常応答       | `202 Accepted`(AUTH-INV-002 と同様に account 有無・確認済み状態を示さない) |
| rate limit超過 | `202`(区別しない)                                                          |

### `GET/POST /api/auth/[...nextauth]`

Auth.js 標準 route(Credentials provider の signin/callback/signout/session)。`authorize` は AUTH-005/AUTH-010 に従い、失敗理由を返さず `null` を返す(Auth.js の generic error 表示に委ねる)。

### `POST /api/v1/auth/password-reset`

| 項目     | 内容                         |
| -------- | ---------------------------- |
| 認証要否 | 不要                         |
| 入力     | `email`                      |
| 正常応答 | `202 Accepted`(AUTH-INV-002) |
| 入力上限 | email 254 文字               |

### `POST /api/v1/auth/password-reset/confirm`

| 項目     | 内容                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| 認証要否 | 不要(token が認可情報を兼ねる)                                                                                        |
| 入力     | `token`, `newPassword`(AUTH-002 準拠)                                                                                 |
| 正常応答 | `200 OK`                                                                                                              |
| エラー   | token 無効/期限切れ/使用済み → `400`、`code: "invalid_or_expired_token"`。password policy 違反 → `422`、`fieldErrors` |
| 入力上限 | token 512 文字、newPassword 128 文字                                                                                  |

## Data and Migration

本節は「どのデータを保持する必要があるか」という契約を示す。テーブル分割・index・保存方式などの実現方法は [../plans/auth-adapter.md](../plans/auth-adapter.md) を参照。

- 認証に使う password hash を、既存の `users`(または関連する identity データ)に対して保持する必要がある。
- `users.email_normalized` は account 全体で一意である制約を維持する(Business Rules 参照)。
- session を DB に永続化する必要がある([ADR-001](../adr/ADR-001-authentication.md))。
- email verification token、password reset token をそれぞれ単回使用・有効期限付きで保持する必要がある。トークンは平文でなくハッシュ化して保持する。
- login/signup/verification-resend/password-reset-request の rate limit 判定に必要な試行履歴を保持する必要がある。判定ウィンドウ(15 分)を超えた履歴は保持し続けない(削除の実装は Plan で定義するが、本 Spec のスコープ内で行う)。
- 平文の token・email 本文を本番相当の永続 store に保持しない(Security and Privacy 参照)。
- 既存 `04-database-design.md` にはこれらのテーブルが含まれていないため、実装時に同ドキュメントへ追記する(Plan Task)。

## Failure and Edge Cases

- signup 時の重複 email → AUTH-INV-002 により情報を漏らさない。
- 期限切れ/使用済み/不正な verification token・reset token → 同一エラー。
- 同一 token への並行リクエスト → 最大 1 件のみ成功(AUTH-INV-001)。
- rate limit 超過 → 通常の失敗/成功と区別できない応答。
- session 期限切れ・改ざん → unauthenticated 扱い。
- email 未確認のまま password reset を完了 → password は更新されるが、email 確認済みになるまで login は引き続き拒否される。

## Security and Privacy

- Data collected: email(正規化済み)、password hash。
- Data sent externally: なし(email 送信は Out of Scope の配送実装に依存する)。
- 保持期間・アクセス範囲: password hash・token hash は account が存在する限り保持し、account 削除時に削除する(T-404 の削除フローに従う)。rate limit 用の試行履歴は判定ウィンドウ(15 分)経過後に破棄する。認証データへのアクセスは本人の認証処理と、運用上必要な最小限の管理操作(T-403 で定義)に限定する。
- Data forbidden in logs: 平文パスワード、verification/reset token の平文、session token。rate limit は email 単位のみで判定するため IP を収集・保存しない(Out of Scope)。
- 平文 token・email 本文を保持する仕組み(開発/テスト用の擬似メール送信を含む)を本番相当の永続 store に置かない。詳細は Plan で定義する。
- 入力サイズ上限: 各 API の「入力上限」表を参照。上限超過はハッシュ計算前に拒否する(AUTH-002)。
- Threats and controls:
  - credential stuffing/brute force → AUTH-010 の rate limit/lockout。
  - session theft → secure/HttpOnly cookie、DB session rotation(password reset 時に全 session 失効)。
  - CSRF → Auth.js 標準の CSRF token + origin validation。
  - account enumeration → AUTH-INV-002(signup/verification 再送/login/password reset request すべてで応答・処理時間を統一)。
  - token 二重使用・競合 → AUTH-INV-001 の不変条件。

## AI Requirements

N/A(本 Spec は AI を扱わない)。

## Observability and Operations

- Logs: login 成功/失敗(pseudonymous ID、生 email は残さない)、lockout 発動、password reset 発行/使用。
- Metrics: login 失敗率、signup 数、email verification 完了率、lockout 発動回数、rate limit 拒否回数。
- Alerts: 短時間での login 失敗急増(credential stuffing の兆候)。
- Runbook: lockout の手動解除手順、reset token の不正発行が疑われる場合の対応手順(詳細は Plan の Rollout and Operations で定義)。
- Rollout/rollback: 新規 route/データの追加のみで既存機能への影響なし。

## Test Coverage Matrix

| Requirement  | Unit                                                        | Integration                                                                                                                         | E2E                           |
| ------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| AUTH-001     | -                                                           | 重複 email での応答統一、account 未作成の確認                                                                                       | signup フォーム送信           |
| AUTH-002     | policy 判定(境界値: 7/8/128/129 文字、制御文字、空白は許容) | policy 違反時の 422、先頭・末尾空白ありパスワードでの登録・照合成功                                                                 | -                             |
| AUTH-003     | token 有効期限判定                                          | 有効/期限切れ/使用済み token 検証                                                                                                   | verification リンク経由の確認 |
| AUTH-004     | -                                                           | 再送時の旧 token 無効化、rate limit                                                                                                 | -                             |
| AUTH-005     | -                                                           | 正常ログイン、generic error(不存在/不一致/email 未確認/lockout で同一)、email 不存在時も dummy hash 検証が実行されること            | login → session 確認          |
| AUTH-006     | -                                                           | session 失効の確認                                                                                                                  | logout 後の保護 route 拒否    |
| AUTH-007     | -                                                           | 存在しない email でも応答統一                                                                                                       | reset request フォーム        |
| AUTH-008     | policy 準拠チェック                                         | 更新後の全 session 失効                                                                                                             | reset confirm → 再ログイン    |
| AUTH-009     | session→actor user ID mapping                               | 期限切れ/改ざん session の拒否                                                                                                      | N/A                           |
| AUTH-010     | 閾値判定ロジック                                            | 閾値超過時の応答統一、時間経過後の解除、判定ウィンドウ超過履歴の削除                                                                | N/A                           |
| AUTH-INV-001 | -                                                           | 同一 token への並行リクエストで成功が 1 件のみ                                                                                      | N/A                           |
| AUTH-INV-002 | -                                                           | signup/verification 再送/login/password reset request の応答(status/body)が存在有無で差がないこと。login の dummy hash 検証実行確認 | N/A                           |

## Open Questions

次の事項は決定済み(2026-09-15/16 レビュー)。

- **password hash の保存先**: `users` へ直接列を持たせる方式を採用(実装の内部構成のため詳細は [../plans/auth-adapter.md](../plans/auth-adapter.md) を参照)。
- **email verification の必須化**: 必須化する。email 未確認のアカウントは login できない(AUTH-005)。
- **login rate limit の具体的閾値**: 直近 15 分間に同一 email 5 回失敗で 15 分間 lockout を採用(AUTH-010)。運用実績に応じて調整可能な設定値として扱う。
- **IP ベースの rate limit**: MVP には含めない(email 単位のみ)。
- **Google/GitHub OAuth**: MVP スコープから除外([ADR-001](../adr/ADR-001-authentication.md) 2026-09-16 改訂)。将来追加する場合は別 Spec を起こす。
- **Admin TOTP 2FA**: T-403 で扱う。本 Spec は一般ユーザー認証のみを対象とする。
- **`/api/v1` と Auth.js 標準 route の整合**: 技術検証は不要と判明した。[ADR-009](../adr/ADR-009-api-style.md)(2026-09-16 accepted)が「外部ライブラリが規定する標準 endpoint は `/api/v1` の例外にできる」と一般則として決定済みのため、Auth.js 標準 route はこの例外規定に従う(API and Events 節に契約境界を記録済み)。

残る Open Questions: なし。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-09-17
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                                                                                                                                 |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Scope、Success Metrics。[01-product-requirements.md](../01-product-requirements.md) 機能要件 1、[ADR-001](../adr/ADR-001-authentication.md)                                                                                        |
| Specification        | Pass   | 実装を左右する未決事項はすべて決定済み(Open Questions 参照)                                                                                                                                                                              |
| Domain and Time      | Pass   | State Transitions で状態変更の主体・許可条件を定義。AUTH-INV-001/AUTH-INV-002 で冪等性・重複処理・競合への対応を定義。タイムゾーン/DST に依存する業務ルールは持たない                                                                    |
| API and Data         | Pass   | API and Events 節で全 endpoint の入力/出力/status/error/上限/認証要否を定義済み。Auth.js 標準 route の `/api/v1` 例外は [ADR-009](../adr/ADR-009-api-style.md) に基づき確定済み。Data and Migration 節で保持データと一意性制約を定義済み |
| Security and Privacy | Pass   | Security and Privacy 節(収集データ、保持期間、アクセス範囲、入力上限、ログ禁止事項、平文データを永続 store に置かない方針を明記)                                                                                                         |
| AI                   | N/A    | 対象外                                                                                                                                                                                                                                   |
| Testing              | Pass   | Test Coverage Matrix に要件 ID × テスト種別の対応、Fake/Stub 方針を定義済み                                                                                                                                                              |
| Operations           | Pass   | Observability and Operations 節に log/metric/alarm/runbook 方針(rate limit 履歴の削除を含む)を定義済み                                                                                                                                   |
| Planning             | Pass   | [../plans/auth-adapter.md](../plans/auth-adapter.md) が存在し本 Spec にリンクしている                                                                                                                                                    |

全 Gate が Pass または根拠付き N/A。2026-09-17 のレビューで Ready とした。

### Accepted Risks

なし
