# AI Contracts / Fake Adapter Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-04
変更区分: Standard
ロードマップ項目: T-302

## 目的

AI coaching(T-304 習慣設計、T-305 週次改善)が共通で使う「型と境界」を、実 provider・queue・DB より前に確定する。provider-neutral な `AiCoachPort`、versioned な入出力 schema、第三者コンテンツ保護の決定論的 validator と fail-closed pipeline、定型 fallback、権利資料 allowlist の契約を、fake adapter とともに実装する。第三者コンテンツ保護の要件は [third-party-content-safety.md](third-party-content-safety.md)(IPG-001〜006)を正本とし、本 Spec は T-302 で実装する範囲を定める。

## 成功指標

- `pass` 以外の AI 本文が、pipeline の戻り値(＝表示・永続化の唯一の入口)に現れない(Unit Test で全 reason code・全失敗経路を確認)。
- validator・parser・provider の例外、timeout、設定欠損のいずれでも、未検証本文を返さず fallback を返す(fail closed)。
- 転載・翻訳・文体模倣・ブランド誤認・権利疑義の adversarial fixture が、すべて `pass` にならない。一般的な習慣助言の fixture は `pass` になる。
- 監査 sink に渡る値が version・status・reason code だけで、入力・生成本文を含まない(Unit Test で確認)。

## 範囲

- Contracts(`packages/contracts`): `HabitDesignInputV1` / `WeeklyImprovementInputV1`(入力)、`HabitDesignProposalV1` / `WeeklyImprovementPlanV1`(出力)、`contentSafety` の runtime schema(zod、`.strict()`)。
- Domain(`packages/domain/src/ai`): 権利資料 record と利用可否の純粋な判定(期限・用途・必須項目)。
- Application(`packages/application/src/ai`): `AiCoachPort`、`ThirdPartyRightsRegistryPort`、`AiAuditSinkPort`、generation 要求の事前検査、`validateGeneratedContent`、versioned fallback、`generateSafeCoaching` pipeline、`admitCorpusSource`、system policy 定数。
- Infrastructure(`packages/infrastructure/src/ai`): `FakeAiCoach`(台本化された成功・refusal・各種失敗)、`InMemoryRightsRegistry`。
- 文書: `docs/05`、`docs/09`、`docs/10`、third-party-content-safety の Open Questions 追記。

## 対象外

- DB・Migration・HTTP endpoint・queue/Lambda(T-303)・実 provider adapter(T-304/T-305、ADR-003)・UI。
- rights registry の永続化(T-302 では in-memory。永続化は運用開始前に別途 Spec 化する)。
- human review queue と管理画面。`required_human_review` は「公開せず fallback を返す」境界までを実装し、queue の代わりに AI 公開 feature flag の停止で運用する。
- false positive 率の閾値と golden dataset の reviewer の決定(beta 前の T-505 判断。IPG Spec の Open Questions に残す)。
- prompt 本文の最適化(adapter 側。T-302 は守るべき制約を `COACHING_SYSTEM_POLICY_V1` として固定するのみ)。

## 機能要件

### AIC-001 Versioned 入出力 schema

- 入力は目的別 DTO(`habit_design` / `weekly_improvement`)で、AI 用ランダム `subjectId`(UUID)、習慣種別・習慣文、決定論的集計、ユーザーが明示入力した自由記述だけを持つ。表示名・email・内部 ID・認証情報は schema に存在しない。
- 出力は `schemaVersion` を持ち、配列・文字列に上限、enum、`additionalProperties: false` 相当(`.strict()`)を持つ。provider の自己申告を信用せず、必ず Application で `safeParse` する。
- `WeeklyImprovementPlanV1` は [05-api-and-ai-design.md](../05-api-and-ai-design.md) の構造に従う。`HabitDesignProposalV1` は習慣作成 DTO と同じ項目(kind/name/purpose/cue/minimumAction)の提案を持ち、AI が設定を直接変更する経路を持たない(提案のみ)。

### AIC-002 AiCoachPort

- `AiCoachPort.generate({ purpose, input, promptVersion, signal })` は `{ outcome: "completed", rawOutput: unknown, model }` または `{ outcome: "refusal" }` を返し、失敗は分類された `AiCoachProviderError`(`rate_limited | timeout | server_error | connection | invalid_request | unknown`)で投げる。provider 固有の response object を返さない。
- 戻り値の `rawOutput` は `unknown` で、Application が schema で絞り込む。tool 呼び出しは T-302 の範囲外(許可しない)。

### AIC-003 Pipeline(`generateSafeCoaching`)

次の順で処理し、各段の失敗は fallback に収束する。

1. 公開 feature flag が無効なら provider を呼ばず fallback(`disabled`)。
2. 事前検査: ユーザー自由記述が第三者文章の再現・翻訳・文体模倣・公式を装う要求を含む場合、provider を呼ばず fallback(`input_rejected`)。
3. provider 呼び出し: timeout は `AbortSignal` で中断。`rate_limited`/`timeout`/`server_error`/`connection` のみを指数 backoff + jitter で最大 3 attempt。`invalid_request`/`unknown` は再試行しない。全失敗は fallback(`provider_unavailable`)。
4. `refusal` は fallback(`provider_refusal`)。再試行しない。
5. 出力の schema 検証。不合格(oversize を含む)は fallback(`invalid_output`)。再生成しない。
6. 決定論的 validator。`pass` のみ公開。`fallback`/`required_human_review` は再生成を最大 1 回行い、再度 `pass` でなければ fallback(`safety_rejected`)。
7. validator や parser が例外を投げた場合は fail closed(`validator_error`)。

戻り値は `{ source: "ai" | "fallback", output, contentSafety, versions }`。`source: "ai"` は `contentSafety.status === "pass"` のときだけ取り得る(型で表現する)。`required_human_review` の本文は戻り値にも監査にも含めず、fallback と reason code だけを返す。

### AIC-004 Content validator(`validateGeneratedContent`)

- 入力は出力中の全文字列と、管理された policy(`ContentSafetyPolicy`: 管理対象の第三者名称リスト、許可資料の参照 excerpt)。コード内に実在の第三者名称を埋め込まない(policy として注入する。fixture は架空名称のみ)。
- 検査と reason code:
  - `third_party_name`: 管理対象名称を含む → `fallback`
  - `promotional_use_of_third_party_name`: 管理対象名称が商品名・機能名・販促(購入・おすすめ・キャンペーン等)と同居 → `required_human_review`
  - `endorsement_claim`: 公式・提携・監修・公認等の示唆 → `fallback`
  - `long_quotation`: 引用符内の長文(閾値超) → `fallback`
  - `excessive_source_overlap`: 許可資料 excerpt と一定長以上の連続一致 → `fallback`
  - `reproduction_instruction`: 本文・翻訳・文体模倣の再現を指示/示唆する表現 → `fallback`
- 複数該当時は reason code をすべて返し、status は `required_human_review` > `fallback` > `pass` で最も厳しいものとする。validator は純粋関数で `validatorVersion` を返す。

### AIC-005 Versioned fallback

- 目的別(`habit_design` / `weekly_improvement`)に、第三者固有表現を含まない定型出力を `fallbackVersion` つきで返す。出力は通常の出力 schema を満たす(`generateSafeCoaching` の戻り値の型が同じ)。
- 利用者の自由記述を引用・転記しない。習慣設計は習慣種別(build/reduce)だけを反映し、週次は最小行動を小さくする定型案を返す(集計から規則的に導く案は T-305 で追加し、`fallbackVersion` を上げる)。

### AIC-006 権利資料 allowlist

- `RightsRecord` は `sourceId`、`origin`、`rightsBasis`、`allowedUses`、`reviewedAt`、`expiresAt` を持つ。必須項目の欠落、期限切れ(`expiresAt <= now`)、許可用途外はすべて deny で、reason code(`rights_record_missing | rights_record_incomplete | rights_expired | rights_use_not_allowed`)を返す。
- `admitCorpusSource` は RAG/few-shot/eval 投入前の判定 use case。deny 時は登録せず、本文なしで監査 sink に reason code を残す。
- `ThirdPartyRightsRegistryPort` は不明な source を `null` として返し、use case は deny とする(deny by default)。

### AIC-007 監査とログ

- `AiAuditSinkPort.record` に渡す値は `purpose`、`schemaVersion`、`promptVersion`、`validatorVersion`、`fallbackVersion`、`status`、`reasonCodes`、`fallbackReason`、attempt 数だけ。入力・生成本文・subject ID を含まない。

## 業務ルールと不変条件

- AIC-INV-001 `pass` でない AI 本文は、戻り値にも監査にも出さない。
- AIC-INV-002 AI は設定を変更しない。pipeline は提案を返すだけで、書き込み port を持たない。
- AIC-INV-003 retry は一時的障害に限定し、最大 3 attempt、exponential backoff + jitter、全体 timeout を持つ。validation/refusal は再試行しない。
- AIC-INV-004 validator 拒否後の再生成は最大 1 回。
- AIC-INV-005 rights 判定は deny by default(不明・期限切れ・用途外・必須項目欠落)。
- AIC-INV-006 reason code・status・fallback reason の追加は exhaustive check でコンパイル時に取りこぼしを検知する。

## 受け入れ基準

```gherkin
Scenario: 一般的な習慣助言
  Given 入力が第三者固有表現を要求していない
  And provider が独自表現の有効な出力を返す
  When generateSafeCoaching を呼ぶ
  Then source は ai、contentSafety.status は pass で出力が返る

Scenario: 第三者文章の再現要求
  Given ユーザーの自由記述が特定書籍の本文や翻訳の再現を要求する
  When generateSafeCoaching を呼ぶ
  Then provider は呼ばれず、source は fallback、fallbackReason は input_rejected

Scenario: 出力に管理対象の第三者名称
  Given provider の出力が管理対象名称を含む
  When validator が判定する
  Then 1 回だけ再生成し、再度拒否なら source は fallback で本文は返らない

Scenario: 販促利用
  Given 出力が管理対象名称を商品名・販促文に使う
  When validator が判定する
  Then status は required_human_review で、AI 本文は返らず fallback が返る

Scenario: validator の例外
  Given validator が例外を投げる
  When generateSafeCoaching を呼ぶ
  Then fail closed で fallback が返り、未検証本文は返らない

Scenario: oversize / 不正な出力
  Given provider の出力が schema 上限を超える、または未知キーを持つ
  When generateSafeCoaching を呼ぶ
  Then 再生成せず fallback(invalid_output) が返る

Scenario: 一時的障害の再試行
  Given provider が 2 回 rate_limited で失敗し 3 回目に成功する
  When generateSafeCoaching を呼ぶ
  Then backoff をはさんで 3 attempt で成功する
  And invalid_request では再試行しない

Scenario: 権利根拠がない資料
  Given 資料に有効な rights record がない(未登録・期限切れ・用途外)
  When admitCorpusSource を呼ぶ
  Then admitted は false で reason code が返り、監査 sink には本文なしで記録される
```

## APIとイベント

- HTTP endpoint・event・DB は追加しない。契約は `packages/contracts/src/ai.ts` の zod schema と `packages/application/src/ai` の port を正本とする。
- `contentSafety` は `{ status, reasonCodes, validatorVersion, fallbackVersion }`。`fallbackVersion` は fallback のとき非 null。
- schema は `schemaVersion: "1"`。非互換変更は新 version を追加し、古い version を書き換えない。
- DB 変更なし(Migration N/A。永続化は T-303 以降が本契約の戻り値を保存する)。

## セキュリティとプライバシー

- Data collected: なし(T-302 は永続化しない)。監査には version・status・reason code のみ。
- Data sent externally: T-302 では外部送信なし(fake のみ)。入力 schema は最小化済みで、email・表示名・内部 ID を持たない。
- Data forbidden in logs: 入力自由記述、生成本文、prompt、raw response、引用候補。typed な監査 record 以外の出力経路を作らない。
- 認可: T-302 は use case の呼び出し側(T-303)が actor の所有権を検証する前提。本 package は user ID を受け取らない。
- IDOR/BOLA: 対象外(resource を扱わない)。Injection: 自由記述は data として扱い、制御文字を拒否する。prompt injection への耐性は validator と fail-closed で補う。
- abuse: 入力長上限、再試行 3 回、再生成 1 回で provider 呼び出しを有限化する。ユーザー単位 rate limit・コスト上限は T-303。

## AI要件

- AI を使う理由と決定論に任せない判断: [01-product-requirements.md](../01-product-requirements.md) と ADR-003 に従う。T-302 は provider を呼ばない基盤のみ。
- AI に任せる判断: 提案文の生成のみ。任せない判断: 公開可否(validator)、設定変更(ユーザー明示承認後に決定論的 use case)。
- prompt / schema / validator / fallback を独立 version で管理する。
- tool は許可しない(allowlist は空)。T-304 以降で追加する場合は Spec を更新する。
- 評価: adversarial fixture と一般助言 fixture を Unit Test に含める(golden dataset の閾値決定は T-505)。

## 可観測性と運用

- `AiAuditSinkPort` が status/reason code/version を記録する。metrics の集計と alarm は T-303 の consumer で接続する。
- Feature flag: pipeline 入力の `publicationEnabled`。停止時は常に fallback。
- rollback: flag 停止＋ fallback 固定。データ変更がないため回復不要。
- 費用: T-302 は provider を呼ばない。T-303 以降で試行回数上限を維持する。

## テスト対応表

| Requirement             | Unit                                                       | Integration | E2E           |
| ----------------------- | ---------------------------------------------------------- | ----------- | ------------- |
| AIC-001                 | 入力/出力 schema の valid/invalid/oversize/未知キー        | N/A         | N/A(UI なし)  |
| AIC-002                 | fake adapter の outcome 全種                               | N/A         | N/A           |
| AIC-003                 | pipeline 全経路、retry/backoff、timeout、再生成上限        | N/A         | T-303 で fake |
| AIC-004                 | 各 reason code、複合、一般助言 false positive、adversarial | N/A         | N/A           |
| AIC-005                 | fallback が schema を満たし第三者名称を含まない            | N/A         | N/A           |
| AIC-006                 | rights 期限・用途・欠落、admit の deny                     | N/A         | N/A           |
| AIC-007                 | 監査 record に本文が含まれない                             | N/A         | N/A           |
| AIC-INV-001/004/005/006 | 上記に包含。exhaustive は型で検査                          | N/A         | N/A           |

DB・HTTP・外部 I/O を追加しないため Integration/E2E は N/A。fake provider と in-memory registry で境界を検証する。

## 未決事項

なし(T-302 の実装を左右する未決事項はない)。次は T-302 では決めず後続へ送ると合意済み: false positive 率の閾値と golden dataset の reviewer(T-505)、human review queue の要否(AI 公開 feature flag 停止で代替)、rights registry の永続化。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-04
Reviewed by: —

| Gate                 | Result | Evidence                                                                       |
| -------------------- | ------ | ------------------------------------------------------------------------------ |
| Product              | Pass   | Goal、Scope/Out of Scope、`docs/09` T-302、IPG-001〜006                        |
| Specification        | Pass   | AIC-001〜007、AIC-INV、Acceptance Criteria。範囲と未決事項の扱いは依頼者が承認 |
| Domain and Time      | Pass   | 権利期限は `Date` を引数で受ける純粋判定。日付・DST を扱う業務状態はなし       |
| API and Data         | Pass   | API/Events 節(HTTP/DB なし、Migration N/A、forward-fix は version 追加)        |
| Security and Privacy | Pass   | Security and Privacy 節、AIC-007                                               |
| AI                   | Pass   | AI Requirements、AIC-003/004/005、AIC-INV-001〜004                             |
| Testing              | Pass   | Test Coverage Matrix。fixture は架空名称のみ                                   |
| Operations           | Pass   | Observability 節(flag 停止で代替)。queue/管理画面は Out of Scope として明示    |
| Planning             | Pass   | [../plans/ai-contracts.md](../plans/ai-contracts.md)                           |

### 受容リスク

- 決定論的 validator は文字列規則であり、言い換えや翻訳された転載の検知漏れが残る。多層防御(system policy、human review、feature flag 停止)と T-505 前の golden dataset 評価で補う。
- 過剰拒否(fail closed)により一般助言が fallback になる場合がある。false positive 率は T-505 前に計測・閾値化する。
- rights registry は in-memory で再起動すると失われる。永続化までは本番で RAG/few-shot を使わない。

### 未決事項

なし
