"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createQueryClient } from "@/lib/api/query-client";

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [queryClient] = useState(() =>
    createQueryClient({
      onUnauthorized: (client) => {
        // session 失効後に前のユーザーのデータを残さない(WUI-005)。
        client.clear();
        router.replace("/login");
      },
    }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
