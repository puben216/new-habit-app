import { describe, expect, it } from "vitest";

import { buildReminderEmail } from "./reminder-email";

describe("buildReminderEmail", () => {
  const input = {
    appUrl: "https://app.example.test",
    unsubscribeUrl: "https://app.example.test/api/v1/notification-unsubscribe?token=t",
  };

  it("定型の件名と、アプリ・配信停止のリンクを含む", () => {
    const email = buildReminderEmail(input);
    expect(email.subject).toBe("今日の習慣を記録しましょう");
    expect(email.text).toContain("アプリを開く: https://app.example.test");
    expect(email.text).toContain(`配信を停止する: ${input.unsubscribeUrl}`);
  });

  it("入力のリンク以外に可変の内容がない(同じ入力なら同じ本文、リンクを抜くと別の入力に依存しない)", () => {
    const a = buildReminderEmail(input);
    const b = buildReminderEmail({ appUrl: "https://other.example.test", unsubscribeUrl: "u" });
    expect(buildReminderEmail(input)).toEqual(a);
    // リンクを置換すると、2 つの本文は同じ定型部分を共有する。
    const normalize = (text: string, links: string[]) =>
      [...links]
        .sort((x, y) => y.length - x.length)
        .reduce((acc, link) => acc.split(link).join("<LINK>"), text);
    expect(normalize(a.text, [input.appUrl, input.unsubscribeUrl])).toBe(
      normalize(b.text, ["https://other.example.test", "u"]),
    );
  });
});
