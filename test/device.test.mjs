import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeInstance, flattenInstances, listInstances } from '../src/device.mjs';
import { loadConfig, PATHS } from '../src/config.mjs';

/**
 * 真实形态（MuMuManager info --vmindex all，v12 NX 实测）：
 * 顶层是**以实例号为键的对象**，index 是字符串，字段用下划线命名。
 */
const REAL_ALL = {
  '0': {
    adb_host_ip: '127.0.0.1',
    adb_port: 16384,
    created_timestamp: 1769944793374264,
    disk_size_bytes: 8820662128,
    error_code: 0,
    headless_pid: 158892,
    hyperv_enabled: false,
    index: '0',
    is_android_started: true,
    is_main: true,
    is_process_started: true,
    launch_err_code: 0,
    main_wnd: '007C0A6E',
    name: 'MuMu安卓设备',
    player_state: 'start_finished',
  },
  '1': {
    adb_port: 16416,
    index: '1',
    is_android_started: false,
    is_main: false,
    is_process_started: false,
    name: 'MuMu安卓设备-1',
  },
};

// ------------------------------------------------------------ 单实例规范化

test('normalizeInstance: 认得实测输出的下划线字段与字符串索引', () => {
  const inst = normalizeInstance(REAL_ALL['0']);
  assert.equal(inst.index, 0, 'index 是字符串 "0"，必须转成数字');
  assert.equal(inst.name, 'MuMu安卓设备');
  assert.equal(inst.adbPort, 16384);
  assert.equal(inst.isMain, true);
  assert.equal(inst.isAndroidStarted, true);
  assert.equal(inst.isProcessStarted, true);
  assert.equal(inst.hypervEnabled, false);
});

test('normalizeInstance: 也认得驼峰字段（不同版本/子命令）', () => {
  const inst = normalizeInstance({
    index: 2,
    name: 'camel',
    adbPort: 16448,
    isMain: false,
    isAndroidStarted: true,
    isProcessStarted: true,
    hypervEnabled: true,
  });
  assert.equal(inst.index, 2);
  assert.equal(inst.adbPort, 16448);
  assert.equal(inst.isAndroidStarted, true);
  assert.equal(inst.hypervEnabled, true);
});

test('normalizeInstance: 布尔字段接受 "true"/1 这类宽松写法', () => {
  const inst = normalizeInstance({ index: '0', is_android_started: 'true', is_process_started: 1 });
  assert.equal(inst.isAndroidStarted, true);
  assert.equal(inst.isProcessStarted, true);
});

test('normalizeInstance: 索引缺失或非法时返回 null', () => {
  assert.equal(normalizeInstance(null), null);
  assert.equal(normalizeInstance([]), null);
  assert.equal(normalizeInstance({ name: '没有索引' }), null);
  assert.equal(normalizeInstance({ index: -1 }), null);
  assert.equal(normalizeInstance({ index: 'abc' }), null);
  assert.equal(normalizeInstance({ index: '' }), null);
});

test('normalizeInstance: 用键名兜底当索引', () => {
  const inst = normalizeInstance({ name: '没有 index 字段' }, '3');
  assert.equal(inst.index, 3);
  assert.equal(inst.name, '没有 index 字段');
});

test('normalizeInstance: adb_port 缺失时给 undefined，而不是 NaN', () => {
  const inst = normalizeInstance({ index: '0', is_android_started: true });
  assert.equal(inst.adbPort, undefined);
  assert.equal(normalizeInstance({ index: '0', adb_port: 'abc' }).adbPort, undefined);
});

test('normalizeInstance: 名字缺失时给可读默认值', () => {
  assert.equal(normalizeInstance({ index: '7' }).name, '实例 7');
});

// ------------------------------------------------------------ 三种整体形态

test('flattenInstances: 「以索引为键的对象」是实测形态，必须被展开', () => {
  // 这条是回归用例：早先只处理数组与「本身就是实例的对象」，
  // 于是真实输出被解析成 3 个没有 index 字段的对象、全部被丢掉。
  const list = flattenInstances(REAL_ALL);
  assert.equal(list.length, 2, '应当展开出 2 个实例');
  assert.deepEqual(list.map((i) => i.index), [0, 1]);
  assert.equal(list[0].isAndroidStarted, true);
  assert.equal(list[1].isAndroidStarted, false);
});

test('flattenInstances: 数组形态', () => {
  const list = flattenInstances([{ index: 0, is_android_started: true }, { index: 1 }]);
  assert.deepEqual(list.map((i) => i.index), [0, 1]);
});

test('flattenInstances: 单个实例对象形态', () => {
  const list = flattenInstances({ index: 5, is_android_started: true, adb_port: 16544 });
  assert.equal(list.length, 1);
  assert.equal(list[0].index, 5);
  assert.equal(list[0].adbPort, 16544);
});

test('flattenInstances: 空值与无关结构返回空数组', () => {
  assert.deepEqual(flattenInstances(null), []);
  assert.deepEqual(flattenInstances(undefined), []);
  assert.deepEqual(flattenInstances('x'), []);
  assert.deepEqual(flattenInstances(42), []);
  assert.deepEqual(flattenInstances({}), []);
  assert.deepEqual(flattenInstances({ foo: { bar: 1 } }), []);
});

test('flattenInstances: 混合内容里只保留合法实例', () => {
  const list = flattenInstances({
    '0': { index: '0', is_android_started: true },
    元数据: { version: '1.0' },
    '2': { index: '2' },
  });
  assert.deepEqual(list.map((i) => i.index), [0, 2]);
});

// ------------------------------------------------------------ 真实 CLI（无模拟器也能跑）

test('listInstances: 真实调用 MuMuManager，读不到实例时给警告而不抛错', async () => {
  const { config } = loadConfig();
  // 把路径指向一个必然失败的可执行文件，验证「不抛错 + 给警告」
  const broken = {
    ...config,
    mumu: { ...config.mumu, manager: PATHS.configFile },
  };
  const warns = [];
  const logger = { info() {}, debug() {}, warn: (m) => warns.push(m), error() {} };

  const list = await listInstances(broken, logger);
  assert.deepEqual(list, []);
  assert.ok(warns.length > 0, '解析不出实例时应当有警告，而不是静默返回空');
});

test('listInstances: 本机装了 MuMu 时能读出实例（未安装则跳过）', async (t) => {
  const { config } = loadConfig();
  const fs = await import('node:fs');
  if (!fs.existsSync(config.mumu.manager)) {
    t.skip(`本机没有 MuMuManager：${config.mumu.manager}`);
    return;
  }
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  const list = await listInstances(config, logger);
  assert.ok(list.length > 0, '本机有 MuMu 就应当至少读出一个实例');
  for (const inst of list) {
    assert.ok(Number.isInteger(inst.index), `index 必须是整数：${JSON.stringify(inst.index)}`);
    assert.ok(inst.adbPort === undefined || Number.isInteger(inst.adbPort));
  }
  console.log(
    `  （实测读到 ${list.length} 个实例：${list.map((i) => `[${i.index}] ${i.name} android=${i.isAndroidStarted} port=${i.adbPort}`).join(' | ')}）`,
  );
});
