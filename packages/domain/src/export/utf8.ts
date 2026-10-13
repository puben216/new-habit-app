/**
 * UTF-8 への変換。Domain は DOM/Node の型(`TextEncoder`)に依存しないため、自前で実装する。
 * 対になっていないサロゲートは U+FFFD に置き換える(`TextEncoder` と同じ挙動)。
 */
export function encodeUtf8(text: string): Uint8Array {
  const length = text.length;

  // 1 回目: バイト数を数える。
  let size = 0;
  for (let i = 0; i < length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogateAt(text, i + 1)) {
      size += 4;
      i += 1;
    } else size += 3; // 通常の BMP の文字、または対になっていないサロゲート(U+FFFD)
  }

  // 2 回目: 書き込む。
  const out = new Uint8Array(size);
  let position = 0;
  for (let i = 0; i < length; i += 1) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      out[position++] = code;
    } else if (code < 0x800) {
      out[position++] = 0xc0 | (code >> 6);
      out[position++] = 0x80 | (code & 0x3f);
    } else {
      if (code >= 0xd800 && code <= 0xdbff && isLowSurrogateAt(text, i + 1)) {
        const low = text.charCodeAt(i + 1);
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
        out[position++] = 0xf0 | (code >> 18);
        out[position++] = 0x80 | ((code >> 12) & 0x3f);
        out[position++] = 0x80 | ((code >> 6) & 0x3f);
        out[position++] = 0x80 | (code & 0x3f);
        continue;
      }
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd; // 対になっていないサロゲート
      out[position++] = 0xe0 | (code >> 12);
      out[position++] = 0x80 | ((code >> 6) & 0x3f);
      out[position++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

function isLowSurrogateAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}
