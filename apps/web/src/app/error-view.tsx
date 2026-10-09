"use client";

import { Button } from "@/components/button";
import { MainContent } from "@/components/main-content";
import { StateMessage } from "@/components/state-message";

export interface ErrorViewProps {
  /** 例外。`message`/`stack` は画面に出さない(WUI-INV-003)。 */
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

/** error boundary の共通表示。固定の文言だけを出す。 */
export function ErrorView({ reset }: ErrorViewProps) {
  return (
    <MainContent>
      <StateMessage
        kind="error"
        headingLevel={1}
        title="問題が発生しました"
        description="しばらくしてからもう一度お試しください。"
        action={<Button onClick={reset}>もう一度試す</Button>}
      />
    </MainContent>
  );
}
