# ADR-001: 認証基盤

Status: accepted
Date: 2026-09-13

Context:
MVP はメールアドレスによる登録・ログイン・パスワード再設定（[01-product-requirements.md](../01-product-requirements.md) FR-1）と、admin ロールの MFA（[08-security.md](../08-security.md)）を必要とする。独自パスワード実装は避けたい。候補は Amazon Cognito、Auth.js（NextAuth）+ OAuth provider、Clerk/Auth0 等のマネージド IdP。Cognito は AWS ネイティブで IAM/ECS と親和するが UI/UX のカスタマイズ性が低く AWS 固有の学習コストが乗る。Clerk/Auth0 は実装が最速だが AWS 外の月額ベンダーコストと依存が増える。

Decision:
認証基盤に Auth.js（NextAuth）を採用する。

- 主手段: メールアドレス + パスワードの Credentials provider（PRD FR-1 を満たすため）。パスワードは argon2id でハッシュ化し、reset token は単回使用・短 TTL で自前実装する。
- MVP では Credentials のみを実装する。Google/GitHub OAuth は当初「補助手段」として計画していたが、T-101（Auth adapter）の Spec 策定時に、PRD FR-1 が OAuth を必須としないこと、OAuth 対応が email 一意性・account 重複処理まわりの複雑さを大きく増やすことを踏まえ、MVP スコープから外した。将来 OAuth を追加する場合は、その時点で別途 Spec を起こし本 ADR を再改訂する。
- Admin MFA: Auth.js に標準機能がないため、admin ロール限定で TOTP ベースの 2FA を別途実装する。当初 T-101 のフォローアップと位置付けていたが、admin 向け管理画面自体が T-403（Minimal admin）まで存在しないため、admin TOTP 2FA の実装は T-403 に含める。T-101 は一般ユーザー認証（Credentials、signup/login/logout/email verification/password reset）のみを対象とする。
- Session: RDS 上の Auth.js adapter table にセッションを永続化する（JWT-only session は使わない）。

Alternatives considered:

- Amazon Cognito: admin MFA は標準搭載だが、UI カスタマイズ性の低さと AWS 固有 API への結合が増える点を理由に見送り。
- Clerk / Auth0: 実装速度は最速だが、AWS 外の継続課金ベンダーが増えることを理由に見送り。

Consequences:

- パスワードハッシュ、reset token 発行/検証、email verification、ログイン rate limit を自前実装する必要がある。
- Admin MFA は T-403 着手まで実装されない。それまで admin ロールでの追加認証は存在しない前提となるが、admin 向け管理画面自体が T-403 まで存在しないため運用上の影響はない。
- OAuth を MVP に含めないため、Google/GitHub アカウントのみを持つユーザーは email + password での登録が必要になる。将来 OAuth を追加する際は、account 重複判定（同一 email の扱い）を再設計する。

Security/operational impact:

- パスワード保存は argon2id、reset token は単回使用・短 TTL・送信ログに平文を残さない。
- ログイン試行に rate limit / lockout / generic error を適用する（[08-security.md](../08-security.md)）。
- Cookie session は secure/HttpOnly、CSRF token/origin validation を行う。
- Admin ロールは通常ロールと分離し、MFA 必須・監査ログ対象とする（T-403 で実装）。

Review date: T-403（Admin MFA 実装）着手時、OAuth 追加の要否検討時、または T-505（限定 beta）判断時に再評価する。

---

2026-09-16 改訂: T-101 Spec 策定時のレビューにより、OAuth を MVP スコープから除外し、Admin MFA の実装を T-403 に移した。
