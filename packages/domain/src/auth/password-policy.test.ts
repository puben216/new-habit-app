import { describe, expect, it } from "vitest";
import { assertPasswordPolicy } from "./password-policy";
import { InvalidPasswordError } from "./errors";

describe("assertPasswordPolicy", () => {
  it("8文字(境界値)のpasswordを受理する", () => {
    expect(() => assertPasswordPolicy("12345678")).not.toThrow();
  });

  it("7文字のpasswordを拒否する", () => {
    expect(() => assertPasswordPolicy("1234567")).toThrow(InvalidPasswordError);
  });

  it("128文字(境界値)のpasswordを受理する", () => {
    expect(() => assertPasswordPolicy("a".repeat(128))).not.toThrow();
  });

  it("129文字のpasswordを拒否する", () => {
    expect(() => assertPasswordPolicy("a".repeat(129))).toThrow(InvalidPasswordError);
  });

  it("文字数判定はtrim後の長さで行うが、password自体は変更しない", () => {
    const password = "  12345678  ";
    expect(() => assertPasswordPolicy(password)).not.toThrow();
  });

  it("trim後に8文字未満となるpasswordを拒否する(空白のみを含む)", () => {
    expect(() => assertPasswordPolicy("       ")).toThrow(InvalidPasswordError);
  });

  it("制御文字を含むpasswordを拒否する", () => {
    const tab = String.fromCharCode(9);
    const nul = String.fromCharCode(0);
    const del = String.fromCharCode(127);
    expect(() => assertPasswordPolicy(`abcdefg${tab}h`)).toThrow(InvalidPasswordError);
    expect(() => assertPasswordPolicy(`abcdefg${nul}h`)).toThrow(InvalidPasswordError);
    expect(() => assertPasswordPolicy(`abcdefg${del}h`)).toThrow(InvalidPasswordError);
  });

  it("先頭・末尾に空白があっても制御文字でなければ受理する", () => {
    expect(() => assertPasswordPolicy(" abcdefgh ")).not.toThrow();
  });
});
