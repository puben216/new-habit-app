"use client";

import "./globals.css";
import { ErrorView, type ErrorViewProps } from "./error-view";

/** root layout 自体が失敗した場合の表示。root layout を置き換えるため html/body を持つ。 */
export default function GlobalError(props: ErrorViewProps) {
  return (
    <html lang="ja">
      <body>
        <ErrorView {...props} />
      </body>
    </html>
  );
}
