/**
 * リマインドメールの定型本文(docs/specs/notification-delivery.md NDL-006)。
 * 習慣名・メモ・表示名などユーザー固有の内容を含めない。
 */
export interface BuildReminderEmailInput {
  readonly appUrl: string;
  readonly unsubscribeUrl: string;
}

export function buildReminderEmail(input: BuildReminderEmailInput): {
  readonly subject: string;
  readonly text: string;
} {
  return {
    subject: "今日の習慣を記録しましょう",
    text: [
      "今日の習慣を記録する時間です。",
      "小さな一歩でも、記録すると続けやすくなります。",
      "",
      `アプリを開く: ${input.appUrl}`,
      "",
      "このメールはリマインド通知の設定に基づいて送っています。",
      `配信を停止する: ${input.unsubscribeUrl}`,
    ].join("\n"),
  };
}
