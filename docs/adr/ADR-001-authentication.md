# ADR-001: 認証基盤

Status: accepted
Date: 2026-09-13

Context:
MVP はメールアドレスによる登録・ログイン・パスワード再設定（[01-product-requirements.md](../01-product-requirements.md) FR-1）と、admin ロールの MFA（[08-security.md](../08-security.md)）を必要とする。独自パスワード実装は避けたい。候補は Amazon Cognito、Auth.js（NextAuth）+ OAuth provider、Clerk/Auth0 等のマネージド IdP。Cognito は AWS ネイティブで IAM/ECS と親和するが UI/UX のカスタマイズ性が低く AWS 固有の学習コストが乗る。Clerk/Auth0 は実装が最速だが AWS 外の月額ベンダーコストと依存が増える。

Decision:
認証基盤に Auth.js（NextAuth）を採用する。

- 主手段: メールアドレス + パスワードの Credentials provider（PRD FR-1 を満たすため）。パスワードは argon2id でハッシュ化し、reset token は単回使用・短 TTL で自前実装する。
- 補助手段: Google / GitHub の OAuth provider を有効化する。
- Admin MFA: Auth.js に標準機能がないため、admin ロール限定で TOTP ベースの 2FA を別途実装する（フォローアップタスクとして T-101 に含める）。
- Session: RDS 上の Auth.js adapter table にセッションを永続化する（JWT-only session は使わない）。

Alternatives considered:

- Amazon Cognito: admin MFA は標準搭載だが、UI カスタマイズ性の低さと AWS 固有 API への結合が増える点を理由に見送り。
- Clerk / Auth0: 実装速度は最速だが、AWS 外の継続課金ベンダーが増えることを理由に見送り。

Consequences:

- パスワードハッシュ、reset token 発行/検証、email verification、ログイン rate limit を自前実装する必要がある。
- Admin MFA を独自実装するため、通常ログインの MFA より検証コストが高い。

Security/operational impact:

- パスワード保存は argon2id、reset token は単回使用・短 TTL・送信ログに平文を残さない。
- ログイン試行に rate limit / lockout / generic error を適用する（[08-security.md](../08-security.md)）。
- Cookie session は secure/HttpOnly、CSRF token/origin validation を行う。
- Admin ロールは通常ロールと分離し、MFA 必須・監査ログ対象とする。

Review date: T-505（限定 beta）判断時、または admin MFA 要件確定時に再評価する。
