import type { NextConfig } from "next";

/**
 * 全 route に付けるセキュリティヘッダー(docs/specs/auth-screens.md セキュリティ節)。
 * - frame-ancestors / X-Frame-Options: 認証画面の clickjacking 対策。
 * - Referrer-Policy: メールのリンクの token が外部へ Referer として漏れないようにする。
 * CSP 全体の設計は T-501 以降(docs/08-security.md)。
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  transpilePackages: [
    "@habit-app/domain",
    "@habit-app/application",
    "@habit-app/infrastructure",
    "@habit-app/contracts",
  ],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
