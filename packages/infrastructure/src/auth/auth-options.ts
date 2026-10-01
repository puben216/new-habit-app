import NextAuth, { type NextAuthConfig, type NextAuthResult } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { login, SESSION_TTL_MS } from "@habit-app/application";
import type {
  AuthRepositoryPort,
  PasswordHasherPort,
  TokenGeneratorPort,
} from "@habit-app/application";

export interface AuthHandlersDeps {
  readonly authRepository: AuthRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  readonly tokenGenerator: TokenGeneratorPort;
  readonly dummyPasswordHash: string;
  readonly authSecret: string;
}

function readSessionToken(token: Record<string, unknown>): string | undefined {
  return typeof token["sessionToken"] === "string" ? (token["sessionToken"] as string) : undefined;
}

/**
 * Auth.js authOptions(docs/plans/auth-adapter.md Approach 節、2026-09-22 改訂)。
 *
 * Credentials provider は `session.strategy: "database"` を許可しない(Auth.js の制約)ため
 * `strategy: "jwt"` を使う。JWT にはセッション状態そのものではなく DB の `sessions` 行を指す
 * `sessionToken` のみを持たせ、jwt/session callback と events.signOut から
 * `AuthRepositoryPort` の session 管理メソッドを直接呼んで DB session を自前管理する
 * (`@auth/prisma-adapter` は使用しない、理由は Plan Approach 節参照)。
 */
export function createAuthHandlers(deps: AuthHandlersDeps): NextAuthResult {
  const config: NextAuthConfig = {
    secret: deps.authSecret,
    session: { strategy: "jwt", maxAge: Math.floor(SESSION_TTL_MS / 1000) },
    providers: [
      Credentials({
        credentials: {
          email: {},
          password: {},
        },
        async authorize(credentials) {
          if (typeof credentials?.email !== "string" || typeof credentials?.password !== "string") {
            return null;
          }

          const result = await login(
            {
              authRepository: deps.authRepository,
              passwordHasher: deps.passwordHasher,
              dummyPasswordHash: deps.dummyPasswordHash,
            },
            { email: credentials.email, password: credentials.password },
          );

          // AUTH-005/AUTH-010: 失敗理由を返さず null を返す(Auth.js の generic error 表示に委ねる)。
          return result.ok ? { id: result.userId } : null;
        },
      }),
    ],
    callbacks: {
      async jwt({ token, user, trigger }) {
        if (trigger === "signIn" && user?.id !== undefined) {
          const sessionToken = deps.tokenGenerator.generate().plaintext;
          const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
          await deps.authRepository.createSession({
            sessionToken,
            userId: user.id,
            expiresAt,
          });
          token["sessionToken"] = sessionToken;
        }
        return token;
      },
      async session({ session, token }) {
        const sessionToken = readSessionToken(token);
        const result =
          sessionToken === undefined
            ? null
            : await deps.authRepository.findSessionUser({ sessionToken, now: new Date() });

        if (result === null) {
          // AUTH-009: 期限切れ/改ざんされた session は unauthenticated として扱う(user を持たせない)。
          return { expires: session.expires };
        }

        return { ...session, user: { ...session.user, id: result.userId } };
      },
    },
    events: {
      async signOut(message) {
        if (!("token" in message) || message.token === null || message.token === undefined) {
          return;
        }
        const sessionToken = readSessionToken(message.token);
        if (sessionToken !== undefined) {
          await deps.authRepository.deleteSession(sessionToken);
        }
      },
    },
  };

  return NextAuth(config);
}
