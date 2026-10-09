"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createQueryClient } from "@/lib/api/query-client";
import { SESSION_EXPIRED_REASON, buildLoginPath } from "@/lib/auth/next-path";

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [queryClient] = useState(() =>
    createQueryClient({
      onUnauthorized: (client) => {
        // session 失効後に前のユーザーのデータを残さない(WUI-005)。
        client.clear();
        router.replace(
          buildLoginPath({
            next: `${window.location.pathname}${window.location.search}`,
            reason: SESSION_EXPIRED_REASON,
          }),
        );
      },
    }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
