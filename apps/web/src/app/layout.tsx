import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SkipLink } from "@/components/skip-link";

import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "AI Habit Coach", template: "%s | AI Habit Coach" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <SkipLink />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
