import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { crc32, dosDateTime, collectFiles, zipDirectory } from '../src/util/zip.mjs';
import { PATHS } from '../src/config.mjs';

const TMP = fs.mkdtempSync(path.join(PATHS.debug, 'test-zip-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 极简 ZIP 读取器：只够验证我们自己写出来的结构。 */
function readZip(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, '应能找到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '中央目录签名');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // 本地头
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, '本地头签名');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(dataStart, dataStart + csize);
    const data = method === 0 ? body : zlib.inflateRawSync(body);

    assert.equal(crc32(data), crc, `${name} 的 CRC 应一致`);
    assert.equal(data.length, usize, `${name} 的长度应一致`);

    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('crc32: 标准测试向量', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('dosDateTime: 1980 年之前会被夹到 1980（ZIP 的起点）', () => {
  const { date } = dosDateTime(new Date(1970, 0, 1));
  assert.equal(date >> 9, 0, '年份字段应为 1980-1980=0');
});

test('dosDateTime: 时间字段按 2 秒精度编码', () => {
  const { time } = dosDateTime(new Date(2026, 0, 1, 13, 45, 30));
  assert.equal(time >> 11, 13);
  assert.equal((time >> 5) & 0x3f, 45);
  assert.equal((time & 0x1f) * 2, 30);
});

test('collectFiles: 递归收集、路径用正斜杠、可按谓词排除', () => {
  const dir = path.join(TMP, 'collect');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'a', 'y.txt'), 'y');
  fs.writeFileSync(path.join(dir, 'a', 'b', 'z.txt'), 'z');

  const all = collectFiles(dir);
  assert.deepEqual(all.map((f) => f.rel), ['a/b/z.txt', 'a/y.txt', 'x.txt'], '应排序且用正斜杠');

  const filtered = collectFiles(dir, { exclude: (rel) => rel.startsWith('a/') });
  assert.deepEqual(filtered.map((f) => f.rel), ['x.txt']);
});

test('zipDirectory: 往返一致（含空文件、二进制、中文名）', () => {
  const dir = path.join(TMP, 'round');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello 世界');
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
  fs.writeFileSync(path.join(dir, 'sub', 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 0]));
  fs.writeFileSync(path.join(dir, '中文名.txt'), '中文内容');
  // 高度可压缩的内容，用来确认真的走了 deflate
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(20000));

  const zip = path.join(TMP, 'round.zip');
  const r = zipDirectory(dir, zip);
  assert.equal(r.entries, 5);

  const entries = readZip(zip);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.data]));
  assert.equal(byName['a.txt'].toString('utf8'), 'hello 世界');
  assert.equal(byName['empty.txt'].length, 0);
  assert.deepEqual([...byName['sub/bin.dat']], [0, 1, 2, 255, 254, 0]);
  assert.equal(byName['中文名.txt'].toString('utf8'), '中文内容');
  assert.equal(byName['big.txt'].length, 20000);
  assert.ok(r.zipBytes < r.rawBytes, '可压缩内容应让 zip 更小');
});

test('zipDirectory: prefix 会给每个条目加一层根目录', () => {
  const dir = path.join(TMP, 'prefixed');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'a');

  const zip = path.join(TMP, 'prefixed.zip');
  zipDirectory(dir, zip, { prefix: 'my-app' });
  assert.deepEqual(readZip(zip).map((e) => e.name), ['my-app/sub/a.txt']);
});

test('zipDirectory: prefix 首尾的斜杠会被去掉，不会产生 // 或绝对路径', () => {
  const dir = path.join(TMP, 'prefix2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const zip = path.join(TMP, 'prefix2.zip');
  zipDirectory(dir, zip, { prefix: '/my-app/' });
  assert.deepEqual(readZip(zip).map((e) => e.name), ['my-app/a.txt']);
});

test('zipDirectory: exclude 生效', () => {
  const dir = path.join(TMP, 'excl');
  fs.mkdirSync(path.join(dir, 'skipme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'k');
  fs.writeFileSync(path.join(dir, 'skipme', 'x.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'drop.log'), 'l');

  const zip = path.join(TMP, 'excl.zip');
  zipDirectory(dir, zip, { exclude: (rel) => rel.startsWith('skipme') || rel.endsWith('.log') });
  assert.deepEqual(readZip(zip).map((e) => e.name), ['keep.txt']);
});

test('zipDirectory: 空目录也能打出合法的空 zip', () => {
  const dir = path.join(TMP, 'empty');
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(TMP, 'empty.zip');
  const r = zipDirectory(dir, zip);
  assert.equal(r.entries, 0);
  assert.deepEqual(readZip(zip), []);
  // EOCD 必须在，且条目数为 0
  const buf = fs.readFileSync(zip);
  assert.equal(buf.readUInt16LE(buf.length - 12), 0);
});
