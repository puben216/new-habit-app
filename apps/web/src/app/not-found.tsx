import Link from "next/link";

import { MainContent } from "@/components/main-content";
import { StateMessage } from "@/components/state-message";

export default function NotFound() {
  return (
    <MainContent>
      <StateMessage
        kind="empty"
        headingLevel={1}
        title="ページが見つかりません"
        description="アドレスを確認するか、トップページへ戻ってください。"
        action={<Link href="/">トップページへ</Link>}
      />
    </MainContent>
  );
}
