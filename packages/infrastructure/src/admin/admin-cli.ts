import type {
  DisableAdminResult,
  GrantAdminResult,
  ResetAdminMfaResult,
} from "@habit-app/application";

/**
 * 管理者の付与・無効化・MFA 再発行の運用スクリプト本体(docs/specs/minimal-admin.md ADM-001)。
 * 引数の解釈と出力の組み立てだけを行い、DB・暗号は use case に任せる(テストしやすくするため)。
 *
 * - 対象ユーザーの email は出力しない(入力として受け取るだけ)。
 * - TOTP の登録用 URI とリカバリーコードは **標準出力にだけ一度** 表示する。ログ・チケットに貼らない。
 */

export interface AdminCliDeps {
  grant(email: string): Promise<GrantAdminResult>;
  disable(email: string): Promise<DisableAdminResult>;
  resetMfa(email: string): Promise<ResetAdminMfaResult>;
}

export interface AdminCliResult {
  readonly exitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

const USAGE = [
  "使い方: pnpm admin:grant|admin:disable|admin:reset-mfa --email <email>",
  "  admin:grant      確認済みのユーザーを管理者にする(無効化済みなら再有効化して MFA を作り直す)",
  "  admin:disable    管理者を無効にする(以後 404 扱い。全 session の MFA 検証も無効)",
  "  admin:reset-mfa  有効な管理者の TOTP 秘密とリカバリーコードを作り直す",
];

type Command = "grant" | "disable" | "reset-mfa";

function parseArgs(argv: readonly string[]): { command: Command; email: string } | null {
  const [command, ...rest] = argv;
  if (command !== "grant" && command !== "disable" && command !== "reset-mfa") return null;
  const flagIndex = rest.indexOf("--email");
  const email = flagIndex >= 0 ? rest[flagIndex + 1] : undefined;
  // --email <値> 以外の引数(未知のフラグ、余分な値)は受け付けない。
  if (email === undefined || email.startsWith("--") || rest.length !== 2 || flagIndex !== 0) {
    return null;
  }
  return { command, email };
}

function enrollmentLines(secrets: {
  adminPublicId: string;
  otpauthUri: string;
  recoveryCodes: readonly string[];
}): string[] {
  return [
    `管理者の公開 ID: ${secrets.adminPublicId}`,
    "",
    "認証アプリ(TOTP)に次の URI を登録してください(QR コード化して読み取るか、URI の secret を手入力):",
    secrets.otpauthUri,
    "",
    `リカバリーコード(各 1 回だけ使える。安全な場所に保管):`,
    ...secrets.recoveryCodes.map((code) => `  ${code}`),
    "",
    "注意: この表示は一度だけです。再表示はできません(必要なら admin:reset-mfa で作り直す)。",
    "      チャット・チケット・ログに貼らないでください。",
  ];
}

export async function runAdminCli(
  argv: readonly string[],
  deps: AdminCliDeps,
): Promise<AdminCliResult> {
  const args = parseArgs(argv);
  if (args === null) return { exitCode: 2, stdout: [], stderr: USAGE };

  switch (args.command) {
    case "grant": {
      const result = await deps.grant(args.email);
      if (result.status === "granted") {
        return {
          exitCode: 0,
          stdout: ["管理者を付与しました。", "", ...enrollmentLines(result)],
          stderr: [],
        };
      }
      return {
        exitCode: 1,
        stdout: [],
        stderr: [
          result.status === "already_active"
            ? "すでに有効な管理者です。MFA を作り直す場合は admin:reset-mfa を使ってください。"
            : "対象のユーザーが見つかりません(email 確認済みで有効なユーザーのみ管理者にできます)。",
        ],
      };
    }
    case "disable": {
      const result = await deps.disable(args.email);
      return result.status === "disabled"
        ? {
            exitCode: 0,
            stdout: [`管理者を無効にしました(公開 ID: ${result.adminPublicId})。`],
            stderr: [],
          }
        : { exitCode: 1, stdout: [], stderr: ["有効な管理者が見つかりません。"] };
    }
    case "reset-mfa": {
      const result = await deps.resetMfa(args.email);
      return result.status === "reset"
        ? {
            exitCode: 0,
            stdout: [
              "MFA を作り直しました(全 session の MFA 検証は無効になりました)。",
              "",
              ...enrollmentLines(result),
            ],
            stderr: [],
          }
        : { exitCode: 1, stdout: [], stderr: ["有効な管理者が見つかりません。"] };
    }
    default: {
      const exhaustive: never = args.command;
      return exhaustive;
    }
  }
}
