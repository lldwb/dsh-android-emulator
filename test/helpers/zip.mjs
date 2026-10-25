/**
 * 测试辅助：手写一个**合法**的 ZIP（只用 `STORED` 条目，不压缩）。
 *
 * 为什么需要它：`apkAbis()` 的契约是「读 zip 中央目录，取 `lib/<abi>/` 去重」，而测试不能依赖
 * 一个真实 APK（86 MB、且不可入库）。用 `zlib` 造 STORED 条目就能覆盖这条路径：STORED 意味着
 * 数据原样存放，所以生成器只需要正确的头部 + CRC32，不需要压缩库。
 *
 * 生成的文件是标准 ZIP：本地文件头 + 中央目录 + EOCD，可以被任何 unzip 实现读取。
 *
 * @module test/helpers/zip
 */

/** CRC32 查表（惰性构建一次）。 */
let crcTable;

/**
 * 计算 CRC32（ZIP 要求）。
 *
 * @param {Buffer} buffer 数据。
 * @returns {number} 无符号 32 位 CRC。
 */
function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 把 `Date` 编码成 ZIP 的 DOS 时间/日期（固定值即可，测试不关心时间戳）。
 *
 * @returns {{ time: number, date: number }} DOS 时间与日期。
 */
function dosTimestamp() {
  // 1980-01-01 00:00:00 是 ZIP 的纪元；这里用一个固定时间保证生成结果可复现。
  return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
}

/**
 * 生成一个 STORED 模式的 ZIP 文件内容。
 *
 * @param {Array<{ name: string, data?: string | Buffer }>} entries 条目列表（路径用 `/` 分隔）。
 * @returns {Buffer} 完整的 zip 字节。
 */
export function makeStoredZip(entries) {
  const { time, date } = dosTimestamp();
  /** @type {Array<{ name: Buffer, data: Buffer, crc: number, offset: number }>} */
  const prepared = [];
  /** @type {Buffer[]} */
  const chunks = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // general purpose bit flag
    local.writeUInt16LE(0, 8); // compression method: 0 = stored
    local.writeUInt16LE(time, 10); // last mod file time
    local.writeUInt16LE(date, 12); // last mod file date
    local.writeUInt32LE(crc, 14); // crc-32
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26); // file name length
    local.writeUInt16LE(0, 28); // extra field length

    prepared.push({ name, data, crc, offset });
    chunks.push(local, name, data);
    offset += local.length + name.length + data.length;
  }

  const centralOffset = offset;
  /** @type {Buffer[]} */
  const centralChunks = [];
  let centralSize = 0;

  for (const entry of prepared) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central file header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0, 8); // general purpose bit flag
    central.writeUInt16LE(0, 10); // compression method
    central.writeUInt16LE(time, 12); // last mod file time
    central.writeUInt16LE(date, 14); // last mod file date
    central.writeUInt32LE(entry.crc, 16); // crc-32
    central.writeUInt32LE(entry.data.length, 20); // compressed size
    central.writeUInt32LE(entry.data.length, 24); // uncompressed size
    central.writeUInt16LE(entry.name.length, 28); // file name length
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // file comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal file attributes
    central.writeUInt32LE(0, 38); // external file attributes
    central.writeUInt32LE(entry.offset, 42); // relative offset of local header

    centralChunks.push(central, entry.name);
    centralSize += central.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // number of this disk
  end.writeUInt16LE(0, 6); // disk where central directory starts
  end.writeUInt16LE(prepared.length, 8); // entries on this disk
  end.writeUInt16LE(prepared.length, 10); // total entries
  end.writeUInt32LE(centralSize, 12); // size of central directory
  end.writeUInt32LE(centralOffset, 16); // offset of central directory
  end.writeUInt16LE(0, 20); // .zip file comment length

  return Buffer.concat([...chunks, ...centralChunks, end]);
}

/**
 * 造一个「看起来像 APK」的 zip：包含若干 `lib/<abi>/libfoo.so`，外加常见的 AndroidManifest。
 *
 * @param {string[]} abis 要包含的 ABI 目录（如 `['arm64-v8a', 'x86_64']`）。
 * @returns {Buffer} zip 字节。
 */
export function makeFakeApkZip(abis) {
  const entries = [{ name: 'AndroidManifest.xml', data: Buffer.from([0x03, 0x00, 0x08, 0x00]) }];
  for (const abi of abis) {
    entries.push({ name: `lib/${abi}/libnative.so`, data: Buffer.from(`ELF-${abi}`, 'utf8') });
  }
  entries.push({ name: 'classes.dex', data: Buffer.from('dex\n035\0', 'utf8') });
  return makeStoredZip(entries);
}
