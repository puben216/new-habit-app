import { NextResponse, type NextRequest } from "next/server";

import { withPathnameHeader } from "./server/pathname-header";

/**
 * 現在の path を request header に載せるだけの proxy。認証の判定は行わない
 * (保護は `(app)` layout の DB session 検証。ADR-010)。
 */
export function proxy(request: NextRequest): NextResponse {
  return NextResponse.next({ request: { headers: withPathnameHeader(request) } });
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
