/**
 * 极简 ZIP 打包（deflate，UTF-8 文件名）。
 *
 * 为什么自己写：Windows 上没有 zip 命令，而 Compress-Archive 要起一个
 * PowerShell 子进程、在沙箱里还会碰到管道限制。Node 自带 zlib，
 * 直接写 ZIP 结构反而更短更可控，也不引入任何依赖。
 *
 * 只支持单文件 ZIP（< 4 GB、条目 < 65535），对分发这个项目绰绰有余。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** 标准 CRC-32（ZIP 用）。 */
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** JS Date → DOS 时间/日期（ZIP 用 1980 起算）。 */
export function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 递归收集文件，返回 {rel, abs} 列表（rel 用正斜杠）。 */
export function collectFiles(dir, { exclude } = {}) {
  const out = [];
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (exclude?.(rel, abs, entry)) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push({ rel, abs });
    }
  };
  walk(dir);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * 把目录打包成 zip。
 * @param {object} [options]
 * @param {string} [options.prefix] 给每个条目加一层根目录名，解压后就是一个文件夹
 *                                  （否则解压出来是一堆散文件，很乱）
 * @returns {{file: string, entries: number, rawBytes: number, zipBytes: number}}
 */
export function zipDirectory(dir, outFile, { exclude, prefix, level = 6, onProgress } = {}) {
  const files = collectFiles(dir, { exclude });
  if (files.length > 65535) throw new Error(`条目过多（${files.length}），超出本实现的 65535 上限`);

  const cleanPrefix = prefix ? prefix.replace(/^\/+|\/+$/g, '') : '';

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, 'w');

  const central = [];
  let offset = 0;
  let rawBytes = 0;
  let done = 0;

  try {
    for (const { rel, abs } of files) {
      const raw = fs.readFileSync(abs);
      rawBytes += raw.length;
      const deflated = zlib.deflateRawSync(raw, { level });
      // 压缩后反而更大就用存储（method 0）
      const useStore = deflated.length >= raw.length;
      const body = useStore ? raw : deflated;
      const method = useStore ? 0 : METHOD_DEFLATE;
      const crc = crc32(raw);
      const { time, date } = dosDateTime(fs.statSync(abs).mtime);
      const nameBuf = Buffer.from(cleanPrefix ? `${cleanPrefix}/${rel}` : rel, 'utf8');

      const local = Buffer.alloc(30);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(FLAG_UTF8, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);

      fs.writeSync(fd, local);
      fs.writeSync(fd, nameBuf);
      fs.writeSync(fd, body);

      central.push({ nameBuf, method, time, date, crc, csize: body.length, usize: raw.length, offset });

      offset += local.length + nameBuf.length + body.length;
      done++;
      onProgress?.(done, files.length, rel);
    }

    const cdStart = offset;
    for (const e of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(20, 4); // version made by
      h.writeUInt16LE(20, 6); // version needed
      h.writeUInt16LE(FLAG_UTF8, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(e.offset, 42);
      fs.writeSync(fd, h);
      fs.writeSync(fd, e.nameBuf);
      offset += h.length + e.nameBuf.length;
    }
    const cdSize = offset - cdStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(fd, eocd);
    offset += eocd.length;
  } finally {
    fs.closeSync(fd);
  }

  return { file: outFile, entries: central.length, rawBytes, zipBytes: offset };
}
