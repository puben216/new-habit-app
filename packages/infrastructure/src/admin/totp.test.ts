import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  totpAt,
  totpStep,
  verifyTotp,
} from "./totp";

/** RFC 6238 Appendix B(SHA-1)。秘密は ASCII の "12345678901234567890"。 */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("hotp / totp(RFC 4226 / RFC 6238 の公式テストベクトル)", () => {
  it.each(RFC_VECTORS)("T=%i の 8 桁は %s、6 桁は下位 6 桁", (seconds, eight) => {
    const counter = Math.floor(seconds / 30);
    expect(hotp(RFC_SECRET, counter, 8)).toBe(eight);
    expect(hotp(RFC_SECRET, counter, 6)).toBe(eight.slice(2));
    expect(totpAt(RFC_SECRET, seconds * 1000)).toBe(eight.slice(2));
  });

  it("RFC 4226 Appendix D の HOTP(カウンタ 0〜9)", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it("ステップは 30 秒単位", () => {
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
  });
});

describe("verifyTotp", () => {
  const NOW = 1_700_000_010_000;
  const step = totpStep(NOW);
  const codeAt = (s: number) => hotp(RFC_SECRET, s);

  it("現在・前・次のステップ(±30 秒)を受理し、一致したステップを返す", () => {
    expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(step), nowMs: NOW, lastStep: null })).toBe(
      step,
    );
    expect(
      verifyTotp({ secret: RFC_SECRET, code: codeAt(step - 1), nowMs: NOW, lastStep: null }),
    ).toBe(step - 1);
    expect(
      verifyTotp({ secret: RFC_SECRET, code: codeAt(step + 1), nowMs: NOW, lastStep: null }),
    ).toBe(step + 1);
  });

  it("±2 ステップ以上ずれたコードは受理しない", () => {
    for (const delta of [-3, -2, 2, 3]) {
      const code = codeAt(step + delta);
      // 偶然別のステップの値と一致する場合は除く(1/10^6 だが決定論的に確認する)。
      const collides = [-1, 0, 1].some((d) => codeAt(step + d) === code);
      if (!collides) {
        expect(verifyTotp({ secret: RFC_SECRET, code, nowMs: NOW, lastStep: null })).toBeNull();
      }
    }
  });

  it("直前に受理したステップ以下は受理しない(replay 防止)。それより新しいステップは受理する", () => {
    expect(
      verifyTotp({ secret: RFC_SECRET, code: codeAt(step), nowMs: NOW, lastStep: step }),
    ).toBeNull();
    expect(
      verifyTotp({ secret: RFC_SECRET, code: codeAt(step - 1), nowMs: NOW, lastStep: step }),
    ).toBeNull();
    expect(
      verifyTotp({ secret: RFC_SECRET, code: codeAt(step + 1), nowMs: NOW, lastStep: step }),
    ).toBe(step + 1);
    expect(
      verifyTotp({ secret: RFC_SECRET, code: codeAt(step), nowMs: NOW, lastStep: step - 1 }),
    ).toBe(step);
  });

  it("形式不正(桁数・文字・空)は null", () => {
    for (const bad of ["", "12345", "1234567", "12345a", " 123456", "１２３４５６"]) {
      expect(verifyTotp({ secret: RFC_SECRET, code: bad, nowMs: NOW, lastStep: null })).toBeNull();
    }
  });

  it("別の秘密のコードは受理しない", () => {
    const other = Buffer.from("other-secret-bytes!!", "ascii");
    expect(
      verifyTotp({ secret: other, code: codeAt(step), nowMs: NOW, lastStep: null }),
    ).toBeNull();
  });

  it("任意の秘密・時刻で、自分が生成したコードは受理され、1 ステップ過ぎると replay は拒否される(プロパティ)", () => {
    const random = createRandom(403);
    for (let i = 0; i < 300; i += 1) {
      const secret = generateTotpSecret();
      const nowMs = Math.floor(random() * 4_000_000_000_000);
      const s = totpStep(nowMs);
      const code = totpAt(secret, nowMs);
      expect(verifyTotp({ secret, code, nowMs, lastStep: null })).toBe(s);
      expect(verifyTotp({ secret, code, nowMs, lastStep: s })).toBeNull();
      expect(verifyTotp({ secret, code, nowMs: nowMs + 30_000, lastStep: s })).toBeNull();
    }
  });
});

describe("base32 / otpauth", () => {
  it("RFC 4648 のテストベクトル(パディングなし)", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded)?.toString()).toBe(plain);
    }
  });

  it("任意のバイト列で往復する。不正な文字は null", () => {
    const random = createRandom(2);
    for (let i = 0; i < 200; i += 1) {
      const bytes = Buffer.from(
        Array.from({ length: Math.floor(random() * 40) }, () => Math.floor(random() * 256)),
      );
      expect(base32Decode(base32Encode(bytes))?.equals(bytes)).toBe(true);
    }
    expect(base32Decode("MZXW6!")).toBeNull();
    expect(base32Decode("mzxw6")?.toString()).toBe("foo");
  });

  it("otpauth URI は secret(base32)・issuer・桁数・周期を含み、email を含まない", () => {
    const uri = buildOtpauthUri({
      secret: RFC_SECRET,
      issuer: "Habit App Admin",
      accountLabel: "admin",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Habit%20App%20Admin:admin\?/);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe(base32Encode(RFC_SECRET));
    expect(params.get("issuer")).toBe("Habit App Admin");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
    expect(params.get("algorithm")).toBe("SHA1");
  });
});
