/**
 * MuMu 自动定位的用例。
 *
 * 全部用临时目录造「假的 MuMu 安装」，不依赖本机是否真的装了 MuMu，
 * 也不碰注册表 / PATH（那两个入口用 useRegistry:false, useWhere:false 关掉）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  locateMumuIn,
  mumuSearchDirs,
  detectMumu,
  resetMumuDetection,
  applyMumuDetection,
  stripDetectedMumuPaths,
  describeMumu,
  adbPath,
} from '../src/mumu-detect.mjs';
import { validateConfig, DEFAULT_CONFIG } from '../src/config.mjs';

const tmpRoots = [];

/** 造一个临时目录，退出时统一清理。 */
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wjdr-mumu-${tag}-`));
  tmpRoots.push(dir);
  return dir;
}

/** 造一棵「像 MuMu Player 12」的目录树。 */
function fakeMuMu12(parent, name = 'MuMuPlayer-12.0') {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, 'nx_main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nx_main', 'MuMuManager.exe'), 'x');
  fs.writeFileSync(path.join(root, 'nx_main', 'adb.exe'), 'x');
  return root;
}

/** 造一棵「像 MuMu 6」的目录树。 */
function fakeMuMu6(parent, name = 'MuMu') {
  const root = path.join(parent, name);
  const bin = path.join(root, 'emulator', 'nemu', 'vmonitor', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'MuMuManager.exe'), 'x');
  fs.writeFileSync(path.join(bin, 'adb_server.exe'), 'x');
  return root;
}

after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ 目录识别

test('locateMumuIn: 认得 MuMu Player 12 的布局', () => {
  const parent = tmpDir('v12');
  const root = fakeMuMu12(parent);
  const hit = locateMumuIn(root);
  assert.equal(hit.path, root);
  assert.equal(hit.manager, path.join(root, 'nx_main', 'MuMuManager.exe'));
  assert.equal(hit.adb, path.join(root, 'nx_main', 'adb.exe'));
});

test('locateMumuIn: 认得 MuMu 6 的布局（adb_server）', () => {
  const parent = tmpDir('v6');
  const root = fakeMuMu6(parent);
  const hit = locateMumuIn(root);
  assert.equal(hit.manager, path.join(root, 'emulator', 'nemu', 'vmonitor', 'bin', 'MuMuManager.exe'));
  assert.equal(hit.adb, path.join(root, 'emulator', 'nemu', 'vmonitor', 'bin', 'adb_server.exe'));
});

test('locateMumuIn: 不是 MuMu 目录就返回 null', () => {
  const dir = tmpDir('empty');
  fs.mkdirSync(path.join(dir, 'nx_main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nx_main', 'something-else.exe'), 'x');
  assert.equal(locateMumuIn(dir), null);
  assert.equal(locateMumuIn(path.join(dir, '不存在')), null);
  assert.equal(locateMumuIn(''), null);
});

test('locateMumuIn: 已知布局没命中时浅层搜索，但不会无限往下翻', () => {
  const parent = tmpDir('deep');
  const shallow = path.join(parent, 'a', 'b');
  fs.mkdirSync(shallow, { recursive: true });
  fs.writeFileSync(path.join(shallow, 'MuMuManager.exe'), 'x');

  assert.equal(locateMumuIn(parent, { walk: false }), null, 'walk:false 时不该找到');
  const hit = locateMumuIn(parent, { walk: true });
  assert.equal(hit.manager, path.join(shallow, 'MuMuManager.exe'));
  assert.equal(hit.path, parent, 'path 始终是「被判定为安装根」的那一层');
  assert.equal(hit.adb, '', '找不到 adb 时给空串，交给 PATH');
});

// ------------------------------------------------------------ 候选目录

test('mumuSearchDirs: 带上环境变量里的目录，且去重', () => {
  const dirs = mumuSearchDirs({
    env: { MUMU_PATH: 'X:/my-mumu', ProgramFiles: 'C:\\Program Files' },
    drives: 'Z', // 不存在的盘符会被跳过
  });
  assert.ok(dirs.includes('X:/my-mumu'));
  assert.ok(dirs.includes('C:\\Program Files'));
  assert.ok(dirs.includes(path.join('C:\\Program Files', 'Netease')));
  assert.equal(new Set(dirs).size, dirs.length, '不应有重复项');
});

test('mumuSearchDirs: 非 Windows 只回环境变量（不猜盘符）', () => {
  const dirs = mumuSearchDirs({ env: { MUMU_PATH: '/opt/mumu' }, platform: 'linux' });
  assert.deepEqual(dirs, ['/opt/mumu']);
});

// ------------------------------------------------------------ 检测入口

test('detectMumu: 在候选目录的子目录里找到 MuMu', () => {
  resetMumuDetection();
  const parent = tmpDir('scan');
  const root = fakeMuMu12(parent, 'MuMuPlayer-12.0');
  const hit = detectMumu({ searchDirs: [parent], useRegistry: false, useWhere: false, env: {} });
  assert.equal(hit.path, root);
  assert.match(hit.source, /扫描目录/);
});

test('detectMumu: 环境变量优先于目录扫描', () => {
  resetMumuDetection();
  const envParent = tmpDir('env');
  const envRoot = fakeMuMu12(envParent, 'MuMuEnv');
  const scanParent = tmpDir('scan2');
  fakeMuMu12(scanParent, 'MuMuScan');

  const hit = detectMumu({
    env: { MUMU_PATH: envRoot },
    searchDirs: [scanParent],
    useRegistry: false,
    useWhere: false,
  });
  assert.equal(hit.path, envRoot);
  assert.equal(hit.source, '环境变量 MUMU_PATH');
});

test('detectMumu: 只给了 MUMU_MANAGER 也能反推出安装根', () => {
  resetMumuDetection();
  const parent = tmpDir('mgr');
  const root = fakeMuMu12(parent);
  const hit = detectMumu({
    env: { MUMU_MANAGER: path.join(root, 'nx_main', 'MuMuManager.exe') },
    searchDirs: [],
    useRegistry: false,
    useWhere: false,
  });
  assert.equal(hit.path, root, 'nx_main 的上一层才是安装根');
  assert.equal(hit.manager, path.join(root, 'nx_main', 'MuMuManager.exe'));
});

test('detectMumu: 找不到就是 null，不抛异常也不猜', () => {
  resetMumuDetection();
  const empty = tmpDir('none');
  assert.equal(
    detectMumu({ searchDirs: [empty], useRegistry: false, useWhere: false, env: {} }),
    null,
  );
});

test('detectMumu: 结果按进程缓存，refresh 才会重算', () => {
  resetMumuDetection();
  const parent = tmpDir('cache');
  fakeMuMu12(parent, 'MuMuA');
  const first = detectMumu({ searchDirs: [parent], useRegistry: false, useWhere: false, env: {} });
  assert.ok(first);

  // 换个候选目录，但没 refresh：应该还是上一次的结果
  const other = tmpDir('cache2');
  const otherRoot = fakeMuMu12(other, 'MuMuB');
  const cached = detectMumu({ searchDirs: [other], useRegistry: false, useWhere: false, env: {} });
  assert.equal(cached.path, first.path);

  const refreshed = detectMumu({
    searchDirs: [other],
    useRegistry: false,
    useWhere: false,
    env: {},
    refresh: true,
  });
  assert.equal(refreshed.path, otherRoot);
});

// ------------------------------------------------------------ 与配置对接

test('applyMumuDetection: 只填空值，用户显式写的绝不覆盖', () => {
  resetMumuDetection();
  const parent = tmpDir('apply');
  const root = fakeMuMu12(parent, 'MuMuDetected');

  // 用户只写了 manager（且真实存在）：path/adb 由它反推，不该去别处找
  const config = { mumu: { path: '', manager: path.join(root, 'nx_main', 'MuMuManager.exe'), adb: '' } };
  const det = applyMumuDetection(config, {
    searchDirs: [parent],
    useRegistry: false,
    useWhere: false,
    env: {},
  });

  assert.equal(config.mumu.manager, path.join(root, 'nx_main', 'MuMuManager.exe'), '显式值必须保留');
  assert.equal(config.mumu.path, root, 'path 应由 manager 反推');
  assert.deepEqual(det.filled, ['path', 'adb']);
  assert.ok(!det.filled.includes('manager'));
  assert.equal(det.source, 'mumu.manager 推导');
});

test('applyMumuDetection: 显式 manager 指向不存在的位置时，不去别处凑一套', () => {
  resetMumuDetection();
  const parent = tmpDir('apply-mix');
  fakeMuMu12(parent, 'MuMuOther');

  const config = { mumu: { path: '', manager: 'D:/用户自己写的/MuMuManager.exe', adb: '' } };
  const det = applyMumuDetection(config, {
    searchDirs: [parent],
    useRegistry: false,
    useWhere: false,
    env: {},
  });

  assert.equal(det, null, '不该把别的安装的 path/adb 拼进来');
  assert.deepEqual(config.mumu, { path: '', manager: 'D:/用户自己写的/MuMuManager.exe', adb: '' });
});

test('applyMumuDetection: 只写了 path 时按已知布局补全 manager/adb', () => {
  resetMumuDetection();
  const parent = tmpDir('pathonly');
  const root = fakeMuMu12(parent);

  const config = { mumu: { path: root, manager: '', adb: '' } };
  const det = applyMumuDetection(config, { searchDirs: [], useRegistry: false, useWhere: false, env: {} });

  assert.equal(config.mumu.manager, path.join(root, 'nx_main', 'MuMuManager.exe'));
  assert.equal(config.mumu.adb, path.join(root, 'nx_main', 'adb.exe'));
  assert.deepEqual(det.filled, ['manager', 'adb']);
  assert.match(det.source, /mumu\.path 推导/);
});

test('applyMumuDetection: 什么都没找到时不动配置，也不报错', () => {
  resetMumuDetection();
  const empty = tmpDir('nothing');
  const config = { mumu: { path: '', manager: '', adb: '' } };
  const det = applyMumuDetection(config, {
    searchDirs: [empty],
    useRegistry: false,
    useWhere: false,
    env: {},
  });
  assert.equal(det, null);
  assert.deepEqual(config.mumu, { path: '', manager: '', adb: '' });
});

test('stripDetectedMumuPaths: 自动填的会被剔掉，用户改过的会留下', () => {
  resetMumuDetection();
  const parent = tmpDir('strip');
  const root = fakeMuMu12(parent);

  const config = { mumu: { path: '', manager: '', adb: '', basePort: 16384 } };
  applyMumuDetection(config, { searchDirs: [parent], useRegistry: false, useWhere: false, env: {} });
  assert.equal(config.mumu.path, root);

  // 用户没改：落盘时三条路径都不该出现
  const saved = stripDetectedMumuPaths(config);
  assert.deepEqual(saved.mumu, { basePort: 16384 });
  assert.equal(config.mumu.path, root, '原对象不能被改动');

  // 用户改了 manager：只保留他改的那条
  config.mumu.manager = 'E:/我就是要用这个/MuMuManager.exe';
  const saved2 = stripDetectedMumuPaths(config);
  assert.equal(saved2.mumu.manager, 'E:/我就是要用这个/MuMuManager.exe');
  assert.equal(saved2.mumu.path, undefined);
  assert.equal(saved2.mumu.adb, undefined);
});

test('stripDetectedMumuPaths: 没有检测记录时原样返回', () => {
  resetMumuDetection();
  const config = { mumu: { manager: 'D:/x/MuMuManager.exe' } };
  assert.equal(stripDetectedMumuPaths(config), config);
});

// ------------------------------------------------------------ 展示与取值

test('adbPath: 没有 adb 时交给 PATH', () => {
  assert.equal(adbPath({ mumu: { adb: 'D:/MuMu/nx_main/adb.exe' } }), 'D:/MuMu/nx_main/adb.exe');
  assert.equal(adbPath({ mumu: { adb: '' } }), 'adb');
  assert.equal(adbPath({}), 'adb');
});

test('describeMumu: 说明路径是哪来的', () => {
  resetMumuDetection();
  const parent = tmpDir('describe');
  fakeMuMu12(parent);

  const config = { mumu: { path: '', manager: '', adb: '' } };
  applyMumuDetection(config, { searchDirs: [parent], useRegistry: false, useWhere: false, env: {} });
  assert.match(describeMumu(config), /自动检测/);

  resetMumuDetection();
  assert.match(describeMumu({ mumu: { manager: 'D:/x/MuMuManager.exe', adb: 'D:/x/adb.exe' } }), /config\/config\.json/);
  assert.match(describeMumu({ mumu: {} }), /未找到 MuMuManager/);
});

// ------------------------------------------------------------ 配置校验

test('DEFAULT_CONFIG: MuMu 路径默认为空（交给自动检测）', () => {
  assert.equal(DEFAULT_CONFIG.mumu.path, '');
  assert.equal(DEFAULT_CONFIG.mumu.manager, '');
  assert.equal(DEFAULT_CONFIG.mumu.adb, '');
});

test('validateConfig: 路径为空只是警告（没装模拟器也要能起界面）', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const soft = validateConfig(config);
  assert.deepEqual(soft.errors, [], '不该挡住启动');
  assert.ok(
    soft.warnings.some((w) => w.includes('未自动检测到 MuMu')),
    `期望提示自动检测没命中，实际 ${JSON.stringify(soft.warnings)}`,
  );

  // doctor（strictPaths）下也仍然是警告：真正的拦截由 doctor 的实连检查来做
  const strict = validateConfig(config, { strictPaths: true });
  assert.ok(strict.warnings.some((w) => w.includes('未自动检测到 MuMu')));
});

test('validateConfig: 用户显式写了但不存在，strictPaths 下是错误', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.mumu.path = 'D:/绝对不存在的目录';
  config.mumu.manager = 'D:/绝对不存在的目录/MuMuManager.exe';
  config.mumu.adb = 'D:/绝对不存在的目录/adb.exe';

  const soft = validateConfig(config);
  assert.deepEqual(soft.errors, []);
  assert.equal(soft.warnings.filter((w) => w.includes('找不到')).length, 3);

  const strict = validateConfig(config, { strictPaths: true });
  assert.equal(strict.errors.filter((e) => e.includes('找不到')).length, 3);
});
