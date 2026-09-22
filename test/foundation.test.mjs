import test from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, PATHS, DEFAULT_CONFIG } from '../src/config.mjs';
import {
  parseArgs,
  parseInstanceArg,
  decideEntries,
  KNOWN_FLAGS,
  USAGE,
} from '../src/cli-args.mjs';
import {
  listPipelineFiles,
  discoverModules,
  validatePipelines,
  firstNodeOf,
  baseNameOf,
  resolveEntry,
} from '../src/resource.mjs';
import * as events from '../src/events.mjs';
import {
  registerCleanup,
  runCleanups,
  hasCleanups,
  resetForTest as resetLifecycle,
} from '../src/lifecycle.mjs';

// ------------------------------------------------------------ 配置校验
// 用纯函数 validateConfig 测，避免为了造错配置去写真实的 config/config.json。

/** 一份保证合法的配置：路径用真实存在的文件顶替（只校验存在性）。 */
function goodConfig() {
  return {
    mumu: {
      path: PATHS.root,
      manager: PATHS.configFile,
      adb: PATHS.configFile,
      basePort: 16384,
      portStep: 32,
    },
    game: { package: 'com.gof.china' },
    runtime: {
      shortSide: 720,
      launchTimeoutMs: 90000,
      taskTimeoutMs: 600000,
      saveDraws: false,
      saveOnError: true,
      saveFailureShot: false,
      logLevel: 'info',
    },
    instances: [{ index: 0, enabled: true, tasks: [] }],
  };
}

test('validateConfig: 合法配置无错误无警告', () => {
  const { errors, warnings } = validateConfig(goodConfig());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('validateConfig: 各类非法值都能被指出来', () => {
  const cases = [
    ['mumu.basePort', (c) => (c.mumu.basePort = 0)],
    ['mumu.basePort', (c) => (c.mumu.basePort = 70000)],
    ['mumu.basePort', (c) => (c.mumu.basePort = 1.5)],
    ['mumu.portStep', (c) => (c.mumu.portStep = 0)],
    ['runtime.shortSide', (c) => (c.runtime.shortSide = 0)],
    ['runtime.taskTimeoutMs', (c) => (c.runtime.taskTimeoutMs = -1)],
    ['runtime.launchTimeoutMs', (c) => (c.runtime.launchTimeoutMs = 'x')],
    ['runtime.logLevel', (c) => (c.runtime.logLevel = 'verbose')],
    ['tasks', (c) => (c.instances[0].tasks = [''])],
    ['tasks', (c) => (c.instances[0].tasks = ['  '])],
    ['tasks', (c) => (c.instances[0].tasks = 'x')],
    ['index 重复', (c) => (c.instances = [{ index: 0 }, { index: 0 }])],
    ['index', (c) => (c.instances = [{ index: -1 }])],
    ['instances', (c) => (c.instances = [])],
  ];
  for (const [needle, mutate] of cases) {
    const c = goodConfig();
    mutate(c);
    const { errors } = validateConfig(c);
    assert.ok(
      errors.some((e) => e.includes(needle)),
      `期望报出含「${needle}」的错误，实际 ${JSON.stringify(errors)}`,
    );
  }
});

test('validateConfig: 路径不存在会报错', () => {
  const c = goodConfig();
  c.mumu.path = 'D:/绝对不存在的目录';
  c.mumu.adb = 'D:/绝对不存在的目录/adb.exe';
  c.mumu.manager = 'D:/绝对不存在的目录/MuMuManager.exe';
  const { errors } = validateConfig(c);
  assert.ok(errors.some((e) => /找不到 MuMu 安装目录/.test(e)), JSON.stringify(errors));
  assert.ok(errors.some((e) => /找不到 adb/.test(e)), JSON.stringify(errors));
  assert.ok(errors.some((e) => /找不到 MuMuManager/.test(e)), JSON.stringify(errors));
});

test('validateConfig: 占位符包名只给警告不给错误', () => {
  const c = goodConfig();
  c.game.package = DEFAULT_CONFIG.game.package;
  const { errors, warnings } = validateConfig(c);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /占位符/.test(w)), JSON.stringify(warnings));
});

// ------------------------------------------------------------ 流水线发现

test('baseNameOf: 去掉 .json 与 .jsonc', () => {
  assert.equal(baseNameOf('10_联盟日常.json'), '10_联盟日常');
  assert.equal(baseNameOf('a.jsonc'), 'a');
  assert.equal(baseNameOf('noext'), 'noext');
});

test('listPipelineFiles: 只收 .json/.jsonc', () => {
  const files = listPipelineFiles();
  assert.ok(files.length > 0, '仓库里应当有流水线文件');
  assert.ok(files.every((f) => f.endsWith('.json') || f.endsWith('.jsonc')));
  assert.ok(files.includes('_common.json'), '共享文件也应在列表里（由 discover 层过滤）');
});

test('discoverModules: 跳过 _ 前缀共享文件、按文件名排序、入口取首个节点', () => {
  const mods = discoverModules();
  assert.ok(mods.length > 0);
  assert.ok(
    !mods.some((m) => m.base.startsWith('_')),
    `共享文件不应出现在模块列表：${JSON.stringify(mods.map((m) => m.base))}`,
  );

  const bases = mods.map((m) => m.base);
  assert.deepEqual(bases, [...bases].sort(), '应按文件名排序（决定执行顺序）');

  for (const m of mods) {
    assert.equal(m.ok, true, `${m.base} 应可解析：${m.error}`);
    assert.ok(m.entry, `${m.base} 应有入口节点`);
  }

  assert.equal(mods.find((m) => m.base === '00_启动游戏')?.entry, '启动游戏');
  assert.equal(mods.find((m) => m.base === '10_联盟日常')?.entry, '联盟日常');
});

test('validatePipelines: 每个文件都可解析且节点非空，entry 就是首个节点', () => {
  const pipes = validatePipelines();
  assert.ok(pipes.length > 0);
  for (const p of pipes) {
    assert.equal(p.ok, true, `${p.file}: ${p.error}`);
    assert.ok(p.nodes.length > 0, `${p.file} 不应是空文件`);
    assert.equal(p.entry, p.nodes[0]);
  }
});

test('firstNodeOf: 不存在的文件返回 null', () => {
  assert.equal(firstNodeOf('绝对不存在的流水线文件'), null);
});

test('resolveEntry: 节点名原样返回、文件名解析成入口、未知原样返回', () => {
  const nodes = ['启动游戏', '联盟日常', '回到主界面'];
  assert.equal(resolveEntry('启动游戏', nodes), '启动游戏');
  assert.equal(resolveEntry('00_启动游戏', nodes), '启动游戏');
  assert.equal(resolveEntry('10_联盟日常', nodes), '联盟日常');
  assert.equal(resolveEntry('不存在的东西', nodes), '不存在的东西');
});

// ------------------------------------------------------------ 参数解析

test('parseArgs: 长选项取值、布尔开关、位置参数', () => {
  const a = parseArgs(['run', '--tasks', 'a,b', '--retry', '2', '--all']);
  assert.deepEqual(a._, ['run']);
  assert.equal(a.tasks, 'a,b');
  assert.equal(a.retry, '2');
  assert.equal(a.all, true);
});

test('parseArgs: 未知选项抛错（而不是静默忽略）', () => {
  assert.throws(() => parseArgs(['--tasl', 'x']), /未知选项/);
  assert.throws(() => parseArgs(['-x']), /未知的短选项/);
});

test('parseArgs: -h / -v 短路', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
});

test('parseArgs: 值不会吞掉下一个选项', () => {
  const a = parseArgs(['--tasks', '--all']);
  assert.equal(a.tasks, true);
  assert.equal(a.all, true);
});

test('parseArgs: 值里允许出现单个短横线', () => {
  const a = parseArgs(['--tag', '-x']);
  assert.equal(a.tag, '-x');
});

test('KNOWN_FLAGS / USAGE: 帮助里提到的选项都在已知集合里', () => {
  for (const m of USAGE.matchAll(/--([a-z-]+)/g)) {
    assert.ok(KNOWN_FLAGS.has(m[1]), `帮助里的 --${m[1]} 未登记在 KNOWN_FLAGS`);
  }
});

test('parseInstanceArg: 未给返回 undefined，非法抛错', () => {
  assert.equal(parseInstanceArg({}), undefined);
  assert.equal(parseInstanceArg({ instance: '2' }), 2);
  assert.equal(parseInstanceArg({ instance: 0 }), 0);
  assert.throws(() => parseInstanceArg({ instance: '-1' }), /非负整数/);
  assert.throws(() => parseInstanceArg({ instance: 'x' }), /非负整数/);
  assert.throws(() => parseInstanceArg({ instance: '1.5' }), /非负整数/);
});

// ------------------------------------------------------------ 任务来源决策

test('decideEntries: --tasks 优先级最高', () => {
  const r = decideEntries({}, { tasks: ['x'] }, { tasks: 'a,b' }, ['a', 'b'], null);
  assert.deepEqual(r.entries, ['a', 'b']);
  assert.equal(r.source, '--tasks');
});

test('decideEntries: 配置里的任务可解析时用配置', () => {
  const r = decideEntries({}, { tasks: ['10_联盟日常'] }, {}, ['联盟日常'], null);
  assert.deepEqual(r.entries, ['10_联盟日常']);
  assert.match(r.source, /config/);
});

test('decideEntries: 配置里的任务解析不了时回退到自动发现并告警', () => {
  const warns = [];
  const logger = { warn: (m) => warns.push(m) };
  const r = decideEntries({}, { tasks: ['不存在的模块'] }, {}, ['联盟日常'], logger);
  assert.match(r.source, /自动发现/);
  assert.ok(r.entries.includes('联盟日常'));
  assert.ok(warns.some((w) => /无法解析/.test(w)), JSON.stringify(warns));
});

test('decideEntries: --all 强制自动发现', () => {
  const r = decideEntries({}, { tasks: ['10_联盟日常'] }, { all: true }, ['联盟日常'], null);
  assert.match(r.source, /自动发现/);
  assert.ok(r.entries.includes('联盟日常'));
});

test('decideEntries: 空 tasks 配置视为自动发现', () => {
  const r = decideEntries({}, { tasks: [] }, {}, ['联盟日常'], null);
  assert.match(r.source, /自动发现/);
});

// ------------------------------------------------------------ 事件总线

test('events: 日志历史是环形缓冲且有上限', () => {
  events.resetForTest();
  for (let i = 0; i < 900; i++) {
    events.publishLog({ ts: '', level: 'info', scope: 't', message: `m${i}` });
  }
  const h = events.getLogHistory();
  assert.equal(h.length, 800, '上限应为 800');
  assert.equal(h[h.length - 1].message, 'm899', '应保留最新的');
  assert.equal(h[0].message, 'm100', '应丢弃最旧的');
});

test('events: 节点历史也有上限', () => {
  events.resetForTest();
  for (let i = 0; i < 400; i++) events.publishNode({ name: `n${i}` });
  const h = events.getNodeHistory();
  assert.equal(h.length, 300);
  assert.equal(h[h.length - 1].name, 'n399');
});

test('events: 运行状态机 begin/setCurrent/addResult/end', () => {
  events.resetForTest();
  assert.equal(events.state.running, false);

  events.beginRun(['a', 'b']);
  assert.equal(events.state.running, true);
  assert.deepEqual(events.state.entries, ['a', 'b']);
  assert.ok(events.state.startedAt > 0);

  events.setCurrent('a');
  assert.equal(events.state.current, 'a');

  events.addResult({ entry: 'a', ok: true });
  assert.equal(events.state.results.length, 1);

  events.endRun();
  assert.equal(events.state.running, false);
  assert.equal(events.state.current, null);
  assert.ok(events.state.finishedAt > 0);
  events.resetForTest();
});

test('events: 订阅者能收到 log / state 事件', () => {
  events.resetForTest();
  const got = [];
  const onLog = (e) => got.push(['log', e.message]);
  const onState = () => got.push(['state']);
  events.bus.on('log', onLog);
  events.bus.on('state', onState);
  try {
    events.publishLog({ ts: '', level: 'info', scope: 's', message: 'hi' });
    events.beginRun(['x']);
  } finally {
    events.bus.off('log', onLog);
    events.bus.off('state', onState);
    // 必须收尾：否则会把 running=true 留给后面的用例（曾导致 web 测试误判）
    events.endRun();
    events.resetForTest();
  }
  assert.deepEqual(got, [['log', 'hi'], ['state']]);
});

// ------------------------------------------------------------ 生命周期

test('lifecycle: 收尾按「后注册先执行」的顺序运行', async () => {
  resetLifecycle();
  const order = [];
  registerCleanup(() => order.push('a'), 'a');
  registerCleanup(() => order.push('b'), 'b');
  assert.equal(hasCleanups(), true);
  await runCleanups();
  assert.deepEqual(order, ['b', 'a']);
  assert.equal(hasCleanups(), false, '跑完后应清空');
});

test('lifecycle: 单个收尾抛错不影响其它收尾', async () => {
  resetLifecycle();
  const done = [];
  registerCleanup(() => {
    throw new Error('boom');
  }, 'bad');
  registerCleanup(() => done.push('ok'), 'good');
  await runCleanups();
  assert.deepEqual(done, ['ok']);
  assert.equal(hasCleanups(), false);
});

test('lifecycle: 注销函数能移除尚未执行的收尾', async () => {
  resetLifecycle();
  const done = [];
  const off = registerCleanup(() => done.push('x'), 'x');
  off();
  await runCleanups();
  assert.deepEqual(done, []);
});

test('lifecycle: 支持异步收尾', async () => {
  resetLifecycle();
  const done = [];
  registerCleanup(async () => {
    await new Promise((r) => setTimeout(r, 5));
    done.push('async');
  }, 'async');
  await runCleanups();
  assert.deepEqual(done, ['async']);
});
