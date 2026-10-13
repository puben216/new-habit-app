"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { ProfileForm } from "./profile-form";
import styles from "./onboarding-dialog.module.css";

export interface OnboardingDialogProps {
  /** server が `Intl.supportedValuesOf("timeZone")` から作った候補。 */
  readonly supportedTimezones: readonly string[];
}

/**
 * 初回の必須設定(表示名・タイムゾーン)を、閉じられないモーダルで求める(docs/specs/profile-screens.md PFS-001/002)。
 *
 * - ブラウザ標準の `<dialog>` の `showModal()` を使う。背後の画面は inert になり、フォーカスはダイアログ内に閉じる。
 * - 必須の設定なので、Esc(`cancel` イベント)では閉じない。外側のクリックでも閉じない(ダイアログ外は操作できない)。
 * - 保存に成功したら `router.refresh()` で server の判定をやり直す。layout が完了済みと判断して子を描画し、
 *   このダイアログは unmount される(元の URL のまま続きの画面を使える)。
 */
export function OnboardingDialog({ supportedTimezones }: OnboardingDialogProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={styles["dialog"]}
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-description"
      onCancel={(event) => event.preventDefault()}
    >
      <h1 id="onboarding-title" className={styles["title"]}>
        はじめての設定
      </h1>
      <p id="onboarding-description" className={styles["description"]}>
        最初に、表示名とタイムゾーンを設定してください。設定が終わると、すべての機能を使えます。
        あとからプロフィールで変更できます。
      </p>
      <ProfileForm
        mode="onboarding"
        supportedTimezones={supportedTimezones}
        onOnboarded={() => router.refresh()}
      />
    </dialog>
  );
}
