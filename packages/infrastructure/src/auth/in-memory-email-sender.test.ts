import { describe, expect, it } from "vitest";
import { createInMemoryEmailSender } from "./in-memory-email-sender";

describe("createInMemoryEmailSender", () => {
  it("送信したverification emailを記録する", async () => {
    const sender = createInMemoryEmailSender();

    await sender.sendVerificationEmail("user@example.com", "token-1");

    expect(sender.sentVerificationEmails).toEqual([{ to: "user@example.com", token: "token-1" }]);
    expect(sender.sentPasswordResetEmails).toEqual([]);
  });

  it("送信したpassword reset emailを記録する", async () => {
    const sender = createInMemoryEmailSender();

    await sender.sendPasswordResetEmail("user@example.com", "reset-token-1");

    expect(sender.sentPasswordResetEmails).toEqual([
      { to: "user@example.com", token: "reset-token-1" },
    ]);
    expect(sender.sentVerificationEmails).toEqual([]);
  });
});
