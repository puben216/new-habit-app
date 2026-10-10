# 今日の記録とチェックイン画面 Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-09
変更区分: Standard
ロードマップ項目: T-215

## 目的

その日の予定の習慣に対して、成功・未実施・スキップを記録し、あとから訂正できるようにする。今日に加え、過去 7 日の記録の補正と、その日の気分・難しさ・メモ(デイリーチェックイン)の記録も画面から行えるようにする。再送や二重クリックで記録が重複しないことを保証する(サーバー側の冪等 upsert に依拠)。基盤は [web-ui-foundation.md](web-ui-foundation.md)、API は [habit-entry.md](habit-entry.md) と [daily-check-in.md](daily-check-in.md) に従う。

## 成功指標

- Member は `/today` で予定の習慣ごとに、成功/未実施/スキップを記録し、同じ画面で訂正できる(E2E)。
- 過去 7 日の日付を選んで、その日の予定を補正できる。範囲外の日付は選べない(E2E)。
- 気分・難しさ・メモを保存でき、再読み込み後も残る(E2E)。
- 二重クリック・再送で記録が増えない(E2E、サーバーの一意制約)。
- 記録の成否判定(build の回数と status の整合、reduce の意味)を画面に持たず、server の `422` を固定文言で表示する(Unit、E2E)。

## 範囲

- `/today` を「今日の記録」画面にする(日付の選択、予定の習慣一覧、記録操作、チェックイン)。
- 日付の選択: 今日から過去 7 日(server が返す範囲)。選択は `?date=YYYY-MM-DD` クエリで表す。
- 記録操作: build は「できた」「できなかった」「スキップ」と、回数が複数の習慣の途中経過の記録。reduce は「回避できた」「してしまった」「スキップ」。訂正は同じ操作の押し直し。
- デイリーチェックイン: 気分(1〜5)、難しさ(1〜5)、メモ。選択日のチェックインを取得して表示し、保存する。
- 新規の読み取り API `GET /api/v1/schedule/{date}`(過去 7 日の補正のため)と、スケジュール応答への `earliestDate` の追加。
- ナビゲーション: 既存の「今日」。文書: 本 Spec、Plan、`docs/05`、`docs/09`。

## 対象外

- 記録・チェックインの履歴一覧、グラフ(T-216)。
- 未来日の記録、7 日より前の補正。
- 記録の削除(未記録に戻す操作)。API が持たない。
- 通知からの deep link、AI の提案(T-3xx)。
- 気分・難しさの意味づけ・分析表示。

## アクターと前提条件

| アクター                     | 前提条件                        |
| ---------------------------- | ------------------------------- |
| Member(オンボーディング完了) | login 済み。`(onboarded)` 配下  |
| Guest / 未完了               | `/login` / `/onboarding` へ誘導 |

## 機能要件

### TUI-001 日付の選択

- 画面は `GET /api/v1/schedule/today` の `date`(今日)と `earliestDate`(最も古い補正可能日)を基準に、選択肢(今日、昨日、…、`earliestDate`)を日付付きで表示する。
- 選択中の日付は `?date=` クエリ。クエリがない/範囲外/不正なら今日を表示する(範囲の判定は選択肢との一致で行い、業務判定は server)。
- 選択肢は `nav` 内の link 群で、現在の選択に `aria-current="date"` を付ける。

### TUI-002 予定の習慣の表示

- 選択日の予定は、今日なら `GET /api/v1/schedule/today`、過去日なら `GET /api/v1/schedule/{date}` から取得する。
- 各習慣は、名前、きっかけ、最小の行動(reduce は代わりの行動も)、目標回数(build)、現在の記録(状態を文字で表示。色だけに依存しない)を表示する。
- 予定がなければ空状態と、習慣管理(`/habits`)への導線。

### TUI-003 記録の作成・訂正

- 操作ごとに `PUT /api/v1/habits/{habitId}/entries/{date}` を送る(`date` は選択日)。
  - build: 「できた」= `{status: "success"}`、「できなかった」= `{status: "missed"}`、「スキップ」= `{status: "skipped"}`。目標回数が 2 以上の習慣には「途中経過」の回数入力と「途中経過を記録」を追加し、`{status: "missed", quantity: N}` を送る(目標未満かの判定は server)。
  - reduce: 「回避できた」= `success`、「してしまった」= `missed`、「スキップ」= `skipped`(quantity は送らない)。
- 現在の記録に対応する操作は `aria-pressed="true"` で示す。別の操作を押せば訂正になる(上書き)。
- 送信中は当該習慣の操作を無効化する(二重送信防止)。成功したら表示を更新(cache 更新)し、「記録しました」を `role="status"` で伝える。
- `422`(`entry_date_out_of_range`、`habit_not_scheduled`、`invalid_habit_entry`)、`409`(`habit_archived`)、`404` は固定文言で習慣のカード内に表示し、一覧を再取得する。

### TUI-004 デイリーチェックイン

- 選択日のチェックイン(`GET /api/v1/daily-check-ins/{date}`)を表示する。`404`(`check_in_not_found`)は「未記録」として空のフォームを出す(エラーにしない)。
- 入力: 気分(1〜5、radio)、難しさ(1〜5、radio)、メモ(複数行、1000 文字の目安)。保存は `PUT`(全項目置換。選択していない項目は `null`)。
- 3 項目がすべて未設定のときは request を送らず「1つ以上入力してください」を表示する(UX。判定は server `422` も固定文言で表示)。
- 成功で「保存しました」を表示し cache を更新する。選択日を切り替えると、その日のチェックインを取得し直す。

### TUI-005 新規 API: 日付指定の予定

- `GET /api/v1/schedule/{date}`: actor の「今日」から過去 7 日前までの日付(今日を含む)に予定された active な習慣と、その日の記録を返す。応答の形は `schedule/today` と同じ(`date` は指定日)。範囲外・未来日は `422`(`entry_date_out_of_range`)、不正な暦日は `422`(`validation_failed`)。認証必須。
- `GET /api/v1/schedule/today` の応答に `earliestDate`(今日から `ENTRY_BACKDATE_LIMIT_DAYS` 日前の暦日)を追加し、`schedule/{date}` の応答にも同じ値を含める(client が 7 を再定義しないため。HENT-INV-005)。

## 業務ルールと不変条件

- TUI-INV-001(業務ロジックを持たない): 予定日判定、成功判定、日付範囲の検証は server(Domain/Application)が行う。client は操作の種類から `status` を決めるのみ(「できた」→ success 等)。
- TUI-INV-002(範囲の単一定義): 過去に遡れる日数は Application の `ENTRY_BACKDATE_LIMIT_DAYS` のみ。client は `earliestDate` を使う。
- TUI-INV-003(冪等): 記録・チェックインは同じ `(習慣, 日)` / `(actor, 日)` で 1 件(server の一意制約)。client の二重送信防止は補助。
- TUI-INV-004(固定文言): server の文字列を描画しない(WUI-INV-003)。
- TUI-INV-005(個人情報の非ログ): メモ・気分・難しさをログ・URL・storage に出さない。メモは XSS を避け文字として描画する。
- TUI-INV-006(所有者限定): 画面は actor 自身のデータのみを扱う。

## 状態遷移

| 現在の記録 | 操作                         | 次の記録               | 拒否される条件                         |
| ---------- | ---------------------------- | ---------------------- | -------------------------------------- |
| 未記録     | できた/できなかった/スキップ | success/missed/skipped | `422`(範囲外・予定なし・不整合)、`409` |
| 任意       | 別の操作                     | 上書き(訂正)           | 同上                                   |
| 任意       | 同じ操作の再押下             | 同一内容(冪等)         | なし                                   |

## 受け入れ基準

```gherkin
Scenario: 今日の習慣を記録して訂正する
  Given 今日が予定日の build 習慣と reduce 習慣を持つ Member
  When /today で「できた」「回避できた」を押す
  Then それぞれの記録が表示され、aria-pressed が押した操作に付く
  When 「できなかった」に押し直す
  Then 記録が上書きされる

Scenario: 複数回の習慣の途中経過
  Given 目標回数 3 の build 習慣
  When 途中経過に 1 を入力して記録する
  Then 「未実施(1/3)」のように途中経過が表示される
  When 途中経過に 3 を入力して記録する
  Then server が拒否し、固定文言のエラーがカード内に表示される

Scenario: 過去 7 日を補正する
  Given 昨日が予定日の習慣
  When 日付で「昨日」を選び「できた」を押す
  Then 昨日の記録として保存され、今日の表示には影響しない
  And 8 日前の日付は選択肢にない

Scenario: 予定のない日
  Given 曜日が対象外の日
  When その日を選ぶ
  Then 空状態が表示される

Scenario: チェックイン
  When 気分 4、難しさ 2、メモを入力して保存する
  Then 「保存しました」が表示され、再読み込み後も同じ値が表示される
  When 3 項目すべて未設定で保存する
  Then request は送られず「1つ以上入力してください」が表示される

Scenario: 二重クリック
  When 「できた」を素早く 2 回押す
  Then PUT は 1 回だけ送られ、記録は 1 件

Scenario: 他ユーザーのデータは見えない
  Given Member A の記録とチェックイン
  When Member B が /today を開く
  Then B 自身の予定のみが表示される
```

## 認可マトリクス

| 操作                                 | Guest | Member | Admin | 所有権ルール         |
| ------------------------------------ | ----: | -----: | ----: | -------------------- |
| `/today` の閲覧・操作                |    No |    Yes |   N/A | session の user のみ |
| `GET /api/v1/schedule/{date}`(新規)  |    No |    Yes |   N/A | actor の習慣のみ     |
| `schedule/today`・entries・check-ins |  既存 |   既存 |   N/A | T-202/T-203 のまま   |

## APIとイベント

- 新規: `GET /api/v1/schedule/{date}`(上記 TUI-005)。入力は path の `date` のみ。応答は `todayScheduleResponseSchema`(`earliestDate` を追加)。エラー: 401、422(`entry_date_out_of_range`/`validation_failed`)。
- 変更(後方互換): `GET /api/v1/schedule/today` の応答に `earliestDate` を追加。
- その他は既存 API の消費のみ。OpenAPI 基盤は未導入のため runtime schema(`packages/contracts`)と本 Spec を正本とし、`docs/05` に追記する。

## データとMigration

N/A。DB の変更はない。

## 失敗・境界ケース

- 日付が範囲外/不正の `?date=`: 今日を表示する。
- 予定取得の失敗: エラー表示と再試行。`401` は login へ。
- 記録の `409`(アーカイブ済み)/`422`: 固定文言をカード内に表示し、予定を再取得して最新にする。
- 日付境界(深夜 0 時をまたいで開いたままの画面): 「今日」は取得時の値。`PUT` の日付は選択日(画面の日付)なので、翌日になっても選択日が範囲内なら成功し、範囲外なら `422` を固定文言で表示して再取得を促す。
- チェックインの `404`: 未記録として扱う(エラー扱いにしない)。
- メモの改行は許可(server)。表示は改行を保持する。

## セキュリティとプライバシー

- 収集データ: 記録、気分、難しさ、メモ(既存)。外部送信なし。
- ログ禁止データ: メモ、気分、難しさ、body。
- 脅威と対策: IDOR(server の所有者限定。E2E で 2 ユーザー)、XSS(メモは React のエスケープ、E2E で HTML 文字列)、CSRF(変更系は server の Origin 検証)、新規 GET は認証必須・actor の習慣のみ・範囲検証。

## AI要件

N/A。

## 可観測性と運用

- ログ・メトリクス: 追加なし(新規 route は既存の handler 方針に従い、想定外の例外は名前のみ)。展開/ロールバック: Feature Flag 不要、revert。後方互換な応答拡張のみ。

## テスト対応表

| 要件    | Unit                                                                                    | Integration                | E2E                                        |
| ------- | --------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------ |
| TUI-001 | 日付選択肢の構築(性質テスト)、`?date=` の解釈                                           | N/A                        | 7 日分の選択肢、範囲外クエリ               |
| TUI-002 | 記録状態の表示ラベル                                                                    | N/A                        | 予定のある/ない日                          |
| TUI-003 | 操作 → request body(reduce は quantity なし)、エラーの固定文言                          | N/A                        | 記録・訂正・途中経過・過去日・二重クリック |
| TUI-004 | チェックイン検証(全未設定)、body 組み立て(null 化)、404 の扱い                          | N/A                        | 保存・再読み込み・未設定                   |
| TUI-005 | Application `getScheduleOnDate`(範囲、他ユーザー、`earliestDate`)、handler(401/422/200) | (既存の repository を利用) | 過去日の取得                               |
| INV-006 | N/A                                                                                     | N/A                        | 2 ユーザーの分離                           |

## 未決事項

なし。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-09
Reviewed by: —

| Gate                 | Result | Evidence                                                       |
| -------------------- | ------ | -------------------------------------------------------------- |
| Product              | Pass   | 目的、成功指標、範囲/対象外。ロードマップ T-215                |
| Specification        | Pass   | TUI-001〜005、TUI-INV-001〜006、状態遷移、受け入れ基準         |
| Domain and Time      | Pass   | 日付範囲・予定判定は server(TUI-INV-001/002)。境界ケースを記載 |
| API and Data         | Pass   | TUI-005(読み取り専用の新規 GET、後方互換な拡張)。DB 変更なし   |
| Security and Privacy | Pass   | セキュリティ節、新規 GET の認証・所有者限定                    |
| AI                   | N/A    | AI を利用しないため                                            |
| Testing              | Pass   | テスト対応表                                                   |
| Operations           | Pass   | 可観測性と運用節                                               |
| Planning             | Pass   | [../plans/today-screens.md](../plans/today-screens.md)         |

### 受容リスク

- 画面を開いたまま日付が変わった場合は、`422` を固定文言で表示して再取得を促す。

### 未決事項

なし
