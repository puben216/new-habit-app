import type { ReactNode } from "react";

import { StateMessage } from "@/components/state-message";
import { OnboardingDialog } from "@/features/profile/onboarding-dialog";
import { isOnboardingRequiredForSession } from "@/server/require-onboarding";

/**
 * オンボーディング完了が必要な画面。未完了のときは子を描画せず、閉じられないモーダルで初回設定を求める
 * (PFS-001)。URL は変えず、保存すると同じ URL の画面が表示される。判定は毎回 server が DB のプロフィールから行う。
 */
export default async function OnboardedLayout({ children }: { children: ReactNode }) {
  if (await isOnboardingRequiredForSession()) {
    return (
      <>
        {/* モーダルの背後(JS が有効になる前、または JS が無効のとき)に見える案内。 */}
        <StateMessage
          kind="empty"
          title="最初に初期設定を行ってください"
          description="表示名とタイムゾーンを設定すると、すべての機能を使えます。"
        />
        <OnboardingDialog supportedTimezones={Intl.supportedValuesOf("timeZone")} />
      </>
    );
  }
  return children;
}
