import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { recoObject, bestOf, allOf } from '../src/util/detail.mjs';
import { decodePng, imageStats, diffRatio } from '../src/util/png.mjs';
import { buildExtrasConfig } from '../src/controller.mjs';
import { readImageSize } from '../src/util/image.mjs';

// ------------------------------------------------------------ 测试用 PNG 编码器
// 自己编码是为了让像素统计逻辑可测且不依赖任何外部图片。

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成 RGBA8 PNG。pixel(x,y) -> [r,g,b,a] */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const solid = (r, g, b) => encodePng(64, 64, () => [r, g, b, 255]);
const gradient = () =>
  encodePng(64, 64, (x, y) => [x * 4, y * 4, (x + y) * 2, 255]);

// ------------------------------------------------------------ RecoDetail 读取

test('recoObject: 单算法形态取 all/filtered/best', () => {
  const reco = {
    algorithm: 'OCR',
    detail: {
      all: [{ box: [1, 2, 3, 4], text: 'a' }],
      filtered: [{ box: [1, 2, 3, 4], text: 'a' }],
      best: { box: [1, 2, 3, 4], text: 'a' },
    },
  };
  assert.equal(allOf(reco).length, 1);
  assert.equal(bestOf(reco).text, 'a');
});

test('recoObject: And/Or 的数组形态不炸，返回空集合', () => {
  const reco = { algorithm: 'And', detail: [{ algorithm: 'OCR', detail: null }] };
  assert.deepEqual(recoObject(reco), { all: [], filtered: [], best: null });
  assert.equal(bestOf(reco), null);
  assert.deepEqual(allOf(reco), []);
});

test('recoObject: detail 为 null/undefined/缺字段都安全', () => {
  for (const reco of [null, undefined, {}, { detail: null }]) {
    assert.equal(bestOf(reco), null, `bestOf(${JSON.stringify(reco)}) 应为 null`);
    assert.deepEqual(allOf(reco), []);
  }
  // best 缺省但 all 有值时不应崩
  assert.equal(bestOf({ detail: { all: [] } }), null);
});

// ------------------------------------------------------------ PNG 解码与统计

test('decodePng: 解出自编码的图，尺寸与通道正确', () => {
  const img = decodePng(solid(10, 20, 30));
  assert.equal(img.width, 64);
  assert.equal(img.height, 64);
  assert.equal(img.channels, 4);
  assert.equal(img.data[0], 10);
  assert.equal(img.data[1], 20);
  assert.equal(img.data[2], 30);
  assert.equal(img.data[3], 255);
});

test('readImageSize: 认得自编码 PNG 的尺寸', () => {
  assert.deepEqual(readImageSize(solid(0, 0, 0)), {
    format: 'png',
    width: 64,
    height: 64,
  });
});

test('imageStats: 纯黑图判为「几乎纯黑」（用来识别没有画面输出）', () => {
  const s = imageStats(solid(0, 0, 0));
  assert.equal(s.isBlank, true);
  assert.deepEqual(s.mean, [0, 0, 0]);
  assert.match(s.verdict, /纯黑/);
});

test('imageStats: 渐变图判为「有明确画面内容」', () => {
  const s = imageStats(gradient());
  assert.equal(s.isBlank, false);
  assert.ok(s.std > 15, `对比度应较高，实际 ${s.std}`);
  assert.match(s.verdict, /画面内容/);
});

test('decodePng: 非 PNG 输入抛错而不是静默返回垃圾', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /PNG/);
  assert.throws(() => decodePng(Buffer.alloc(0)), /PNG/);
});

test('diffRatio: 同图差异 0，黑白图差异 1', () => {
  const black = solid(0, 0, 0);
  assert.equal(diffRatio(black, solid(0, 0, 0)), 0);
  assert.equal(diffRatio(black, solid(255, 255, 255)), 1);
});

test('diffRatio: 尺寸不同视为完全不同', () => {
  const a = encodePng(32, 32, () => [0, 0, 0, 255]);
  const b = encodePng(64, 64, () => [0, 0, 0, 255]);
  assert.equal(diffRatio(a, b), 1);
});

// ------------------------------------------------------------ extras 配置
// 回归点：设备扫描返回的 config 是 "{}"（非 nullish），早先用 ?? 兜底不会触发，
// 导致 MuMu 加速静默失效（截图 435ms 而不是 16ms）。

test('buildExtrasConfig: 设备配置为 "{}" 时也必须补上 mumu.path', () => {
  const json = buildExtrasConfig('{}', 0, 'D:/MuMu');
  const cfg = JSON.parse(json);
  assert.equal(cfg.extras.mumu.enable, true);
  assert.equal(cfg.extras.mumu.index, 0);
  assert.equal(cfg.extras.mumu.path, 'D:/MuMu');
});

test('buildExtrasConfig: null / undefined / 非法 JSON / 空串都能兜住', () => {
  for (const input of [null, undefined, '', '{oops', '[]', 'null']) {
    const cfg = JSON.parse(buildExtrasConfig(input, 2, 'D:/MuMu'));
    assert.equal(cfg.extras.mumu.path, 'D:/MuMu', `输入 ${JSON.stringify(input)} 应补上 path`);
    assert.equal(cfg.extras.mumu.index, 2);
    assert.equal(cfg.extras.mumu.enable, true);
  }
});

test('buildExtrasConfig: 保留设备配置里的其它字段，且节点配置优先', () => {
  const json = buildExtrasConfig(
    JSON.stringify({ extras: { mumu: { path: 'X:/old', index: 9 }, other: 1 }, foo: 'bar' }),
    3,
    'D:/MuMu',
  );
  const cfg = JSON.parse(json);
  assert.equal(cfg.foo, 'bar');
  assert.equal(cfg.extras.other, 1);
  assert.equal(cfg.extras.mumu.path, 'D:/MuMu', 'path 必须被我们覆盖为已知正确值');
  assert.equal(cfg.extras.mumu.index, 3);
});

test('buildExtrasConfig: 非 0 实例索引要如实写入（多开）', () => {
  const cfg = JSON.parse(buildExtrasConfig('{}', 5, 'D:/MuMu'));
  assert.equal(cfg.extras.mumu.index, 5);
});
