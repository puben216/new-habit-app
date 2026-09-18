import { describe, expect, it } from "vitest";
import { createCryptoTokenGenerator } from "./crypto-token-generator";

describe("createCryptoTokenGenerator", () => {
  it("generateは毎回異なるplaintextを返し、hashはplaintextから一意に決まる", () => {
    const generator = createCryptoTokenGenerator();
    const first = generator.generate();
    const second = generator.generate();

    expect(first.plaintext).not.toBe(second.plaintext);
    expect(first.hash).not.toBe(second.hash);
    expect(generator.hash(first.plaintext)).toBe(first.hash);
  });

  it("hash()は同一plaintextに対して常に同じ値を返す(検証時の照合に使える)", () => {
    const generator = createCryptoTokenGenerator();
    const { plaintext, hash } = generator.generate();

    expect(generator.hash(plaintext)).toBe(hash);
    expect(generator.hash(plaintext)).toBe(generator.hash(plaintext));
  });

  it("平文tokenをそのままhashとして保存しない", () => {
    const generator = createCryptoTokenGenerator();
    const { plaintext, hash } = generator.generate();

    expect(hash).not.toBe(plaintext);
  });
});
