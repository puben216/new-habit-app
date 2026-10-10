import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP(RFC 6238)。認証アプリとの互換性のため HMAC-SHA1・30 秒・6 桁。
 * 秘密は Buffer のまま扱い、ログ・エラーに含めない。
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 前後 1 ステップ(±30 秒)の時刻ずれを許容する。 */
export const TOTP_WINDOW_STEPS = 1;
const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** RFC 4648 の base32(パディングなし。認証アプリに渡す表現)。 */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** base32 をバイト列にする。不正な文字があれば `null`。 */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** HOTP(RFC 4226)。`counter` は 64 ビットの big-endian で HMAC する。 */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(message).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** 時刻(ミリ秒)に対する TOTP のステップ(30 秒単位)。 */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpAt(secret: Buffer, nowMs: number): string {
  return hotp(secret, totpStep(nowMs));
}

/**
 * TOTP を検証する。前後 `TOTP_WINDOW_STEPS` ステップを許容し、`lastStep` 以下のステップは
 * 受理しない(replay 防止)。比較は定数時間で、一致位置による処理時間の差を作らないよう
 * 候補をすべて比較してから結果を決める。受理できたら一致したステップ、できなければ `null`。
 */
export function verifyTotp(input: {
  readonly secret: Buffer;
  readonly code: string;
  readonly nowMs: number;
  readonly lastStep: number | null;
}): number | null {
  if (!/^\d{6}$/.test(input.code)) return null;
  const given = Buffer.from(input.code, "utf8");
  const current = totpStep(input.nowMs);
  let matched: number | null = null;
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(input.secret, step), "utf8");
    const equal = timingSafeEqual(given, expected);
    const fresh = input.lastStep === null || step > input.lastStep;
    // 複数一致しうる境界では新しい(大きい)ステップを採る。
    if (equal && fresh && (matched === null || step > matched)) matched = step;
  }
  return matched;
}

/** 認証アプリに登録する otpauth URI。accountLabel は個人情報を含まない値にする。 */
export function buildOtpauthUri(input: {
  readonly secret: Buffer;
  readonly issuer: string;
  readonly accountLabel: string;
}): string {
  const issuer = encodeURIComponent(input.issuer);
  const label = `${issuer}:${encodeURIComponent(input.accountLabel)}`;
  const params = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
