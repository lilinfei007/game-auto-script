import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveInstance,
  pickInstances,
  stripJsonComments,
  loadConfig,
  DEFAULT_CONFIG,
} from '../src/config.mjs';
import { extractJsonValues } from '../src/util/exec.mjs';
import { orMethods, decodeMethods } from '../src/controller.mjs';
import { readImageSize, shortSide } from '../src/util/image.mjs';

// ------------------------------------------------------------ 实例端口映射

test('resolveInstance: 端口按 basePort + portStep * index 递增（MuMu 步长 32）', () => {
  const config = { mumu: { basePort: 16384, portStep: 32 } };
  assert.equal(resolveInstance(config, 0).address, '127.0.0.1:16384');
  assert.equal(resolveInstance(config, 1).address, '127.0.0.1:16416');
  assert.equal(resolveInstance(config, 2).address, '127.0.0.1:16448');
  assert.equal(resolveInstance(config, 3).port, 16480);
});

test('resolveInstance: 自定义步长也成立', () => {
  const config = { mumu: { basePort: 20000, portStep: 10 } };
  assert.equal(resolveInstance(config, 5).port, 20050);
});

test('pickInstances: 未指定索引时取启用项，指定时精确匹配', () => {
  const config = {
    instances: [
      { index: 0, enabled: true },
      { index: 1, enabled: false },
      { index: 2, enabled: true },
    ],
  };
  assert.deepEqual(
    pickInstances(config).map((i) => i.index),
    [0, 2],
  );
  assert.equal(pickInstances(config, 2)[0].index, 2);
  assert.throws(() => pickInstances(config, 1), /未启用|不存在/);
});

// ------------------------------------------------------------ JSONC 与解析

test('stripJsonComments: 去掉行注释并保持 JSON 可解析', () => {
  const text = '{\n  // 行注释\n  "a": 1, /* 块注释 */\n  "b": "http://x" // 尾注释\n}';
  const parsed = JSON.parse(stripJsonComments(text));
  assert.deepEqual(parsed, { a: 1, b: 'http://x' });
});

test('stripJsonComments: 字符串内的 // 与 /* 不被当作注释', () => {
  const text = '{ "url": "http://a/*b*/", "c": 2 }';
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { url: 'http://a/*b*/', c: 2 });
});

test('extractJsonValues: 抽取多段顶层 JSON（MuMuManager 多实例输出）', () => {
  const text = 'noise {"index":"0","name":"A"} middle {"index":"1","name":"B"} tail';
  const values = extractJsonValues(text);
  assert.equal(values.length, 2);
  assert.equal(values[0].index, '0');
  assert.equal(values[1].name, 'B');
});

test('extractJsonValues: 嵌套对象与字符串中的花括号', () => {
  const text = '{"a":{"b":[1,2,{"c":3}]},"d":"}{"}';
  const [v] = extractJsonValues(text);
  assert.deepEqual(v, { a: { b: [1, 2, { c: 3 }] }, d: '}{' });
});

test('extractJsonValues: 非法片段被丢弃而不抛异常', () => {
  assert.deepEqual(extractJsonValues('{not json}'), []);
  assert.deepEqual(extractJsonValues(''), []);
});

// ------------------------------------------------------------ 掩码运算

test('orMethods: 把 EmulatorExtras 并进默认输入掩码（修复默认值不含 extras 的问题）', () => {
  const DEF_INPUT = '18446744073709551607'; // ~8，即不含 EmulatorExtras
  const withExtras = orMethods(DEF_INPUT, '8');
  assert.equal(withExtras, '18446744073709551615'); // 全量

  const names = decodeMethods(withExtras, {
    AdbShell: '1',
    MinitouchAndAdbKey: '2',
    Maatouch: '4',
    EmulatorExtras: '8',
    All: '18446744073709551615',
    Default: DEF_INPUT,
  });
  assert.ok(names.includes('EmulatorExtras'), `应包含 EmulatorExtras，实际 ${names}`);
  assert.ok(names.includes('Maatouch'));
});

test('orMethods: 默认截图掩码并上 extras 后包含 EmulatorExtras', () => {
  const DEF_SCREENCAP = '18446744073709551559';
  const merged = orMethods(DEF_SCREENCAP, '64');
  const names = decodeMethods(merged, {
    Encode: '2',
    RawWithGzip: '4',
    EmulatorExtras: '64',
    All: '18446744073709551615',
    Default: DEF_SCREENCAP,
  });
  assert.ok(names.includes('EmulatorExtras'), `应包含 EmulatorExtras，实际 ${names}`);
});

test('orMethods: 忽略空值', () => {
  assert.equal(orMethods('1', undefined, null, '2'), '3');
  assert.equal(orMethods(), '0');
});

// ------------------------------------------------------------ 图片尺寸

test('readImageSize: 解析 PNG 头部宽高', () => {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(0x89504e47, 0); // PNG 魔数
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(1280, 16);
  buf.writeUInt32BE(720, 20);
  const size = readImageSize(buf);
  assert.deepEqual(size, { format: 'png', width: 1280, height: 720 });
  assert.equal(shortSide(size), 720);
});

test('readImageSize: 无法识别时返回 null', () => {
  assert.equal(readImageSize(Buffer.from('not an image')), null);
  assert.equal(shortSide(null), null);
});

// ------------------------------------------------------------ 配置校验

test('loadConfig: 默认配置结构完整', () => {
  assert.equal(DEFAULT_CONFIG.mumu.basePort, 16384);
  assert.equal(DEFAULT_CONFIG.mumu.portStep, 32);
  assert.equal(DEFAULT_CONFIG.runtime.shortSide, 720);
});

test('loadConfig: 读取真实 config/config.json 且无致命错误', () => {
  const { config, errors } = loadConfig();
  assert.deepEqual(errors, [], `不应有配置错误：${errors.join('; ')}`);
  assert.ok(Array.isArray(config.instances) && config.instances.length > 0);
});

test('loadConfig: game.package 为占位符时给出警告而非错误', () => {
  const { warnings } = loadConfig();
  if (loadConfig().config.game.package === DEFAULT_CONFIG.game.package) {
    assert.ok(
      warnings.some((w) => /占位符/.test(w)),
      `应有占位符警告，实际 ${JSON.stringify(warnings)}`,
    );
  }
});
