import { describe, expect, it } from "vitest";
import { isValidCalendarDate, previousCalendarDate } from "./calendar-date";

describe("isValidCalendarDate", () => {
  it("実在する暦日を受理する", () => {
    expect(isValidCalendarDate("2024-01-01")).toBe(true);
    expect(isValidCalendarDate("2024-02-29")).toBe(true); // うるう年
  });

  it("実在しない暦日を拒否する", () => {
    expect(isValidCalendarDate("2023-02-29")).toBe(false); // 非うるう年
    expect(isValidCalendarDate("2024-13-01")).toBe(false);
    expect(isValidCalendarDate("2024-00-01")).toBe(false);
    expect(isValidCalendarDate("2024-01-32")).toBe(false);
  });

  it("フォーマットが不正な値を拒否する", () => {
    expect(isValidCalendarDate("2024/01/01")).toBe(false);
    expect(isValidCalendarDate("not-a-date")).toBe(false);
    expect(isValidCalendarDate("")).toBe(false);
  });
});

describe("previousCalendarDate", () => {
  it("前日を返す", () => {
    expect(previousCalendarDate("2024-03-02")).toBe("2024-03-01");
  });

  it("月またぎでも正しく前日を返す", () => {
    expect(previousCalendarDate("2024-03-01")).toBe("2024-02-29"); // うるう年
    expect(previousCalendarDate("2023-03-01")).toBe("2023-02-28");
  });

  it("年またぎでも正しく前日を返す", () => {
    expect(previousCalendarDate("2024-01-01")).toBe("2023-12-31");
  });
});
