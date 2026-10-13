import { encodeUtf8 } from "./utf8";

/**
 * 保存のみ(無圧縮)の ZIP の組み立て(docs/specs/data-export.md EXP-006)。
 * 圧縮しないため実装が小さく、検証しやすい。ファイル名は ASCII のみ(UTF-8 フラグも付ける)。
 * ZIP64 は使わない(成果物は 20 MiB の上限があるため、各サイズ・件数は 32 ビットに収まる)。
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32(IEEE 802.3。ZIP の標準)。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** ディレクトリを含まない ASCII のファイル名。 */
  readonly name: string;
  readonly data: Uint8Array;
}

const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_ENTRIES = 1000;

/** MS-DOS の日付・時刻(2 秒単位、1980 年以降)。範囲外は 1980-01-01 00:00:00。 */
function dosDateTime(timestamp: Date): { readonly date: number; readonly time: number } {
  const year = timestamp.getUTCFullYear();
  if (year < 1980 || year > 2107) return { date: (1 << 5) | 1, time: 0 };
  return {
    date: ((year - 1980) << 9) | ((timestamp.getUTCMonth() + 1) << 5) | timestamp.getUTCDate(),
    time:
      (timestamp.getUTCHours() << 11) |
      (timestamp.getUTCMinutes() << 5) |
      Math.floor(timestamp.getUTCSeconds() / 2),
  };
}

/** 保存のみの ZIP を組み立てる。ファイル名が不正・重複、または件数が多すぎる場合は例外。 */
export function buildStoredZip(entries: readonly ZipEntry[], timestamp: Date): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new Error("too many zip entries");
  const names = new Set<string>();
  for (const entry of entries) {
    if (!FILE_NAME_PATTERN.test(entry.name) || names.has(entry.name)) {
      throw new Error("invalid zip entry name");
    }
    names.add(entry.name);
  }

  const { date, time } = dosDateTime(timestamp);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const push = (chunk: Uint8Array) => {
    parts.push(chunk);
    offset += chunk.length;
  };

  for (const entry of entries) {
    const name = encodeUtf8(entry.name);
    const size = entry.data.length;
    const crc = crc32(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // flags: UTF-8 names
    local.setUint16(8, 0, true); // method: stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // version made by
    header.setUint16(6, 20, true); // version needed
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, date, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint16(30, 0, true); // extra
    header.setUint16(32, 0, true); // comment
    header.setUint16(34, 0, true); // disk
    header.setUint16(36, 0, true); // internal attrs
    header.setUint32(38, 0, true); // external attrs
    header.setUint32(42, offset, true); // local header offset

    central.push(new Uint8Array(header.buffer), name);
    push(new Uint8Array(local.buffer));
    push(name);
    push(entry.data);
  }

  const centralStart = offset;
  for (const chunk of central) push(chunk);
  const centralSize = offset - centralStart;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  push(new Uint8Array(end.buffer));

  const result = new Uint8Array(offset);
  let position = 0;
  for (const chunk of parts) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
}
