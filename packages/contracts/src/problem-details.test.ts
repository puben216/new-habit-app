import { describe, expect, it } from "vitest";
import { createProblemDetails } from "./problem-details";

describe("createProblemDetails", () => {
  it("code/message/fieldErrorsに加えrequestIdを自動採番する", () => {
    const problem = createProblemDetails({
      code: "invalid_or_expired_token",
      message: "token is invalid or expired",
    });

    expect(problem.code).toBe("invalid_or_expired_token");
    expect(problem.message).toBe("token is invalid or expired");
    expect(problem.fieldErrors).toBeUndefined();
    expect(problem.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("呼び出しごとに異なるrequestIdを発行する", () => {
    const a = createProblemDetails({ code: "x", message: "x" });
    const b = createProblemDetails({ code: "x", message: "x" });
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("fieldErrorsを保持する", () => {
    const problem = createProblemDetails({
      code: "validation_failed",
      message: "invalid input",
      fieldErrors: { email: ["must be a valid email"] },
    });
    expect(problem.fieldErrors).toEqual({ email: ["must be a valid email"] });
  });
});
