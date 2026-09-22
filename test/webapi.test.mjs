import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startWebServer, checkOrigin, checkToken } from '../src/web.mjs';
import { loadConfig, PATHS } from '../src/config.mjs';
import * as events from '../src/events.mjs';

const { config } = loadConfig();
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** 记录调用的假执行层，覆盖实时画面 / 手动操作两条链路。 */
function makeDeviceRunner(overrides = {}) {
  const calls = { startLive: [], stopLive: 0, shot: [], tap: [], swipe: [] };
  return {
    calls,
    getRunState: () => events.buildRunState(),
    async start() {
      events.beginRun(['(fake)']);
      return { ok: true, results: [] };
    },
    async stop() {},
    async startLive(opts) {
      calls.startLive.push(opts);
      return { controller: {}, reused: false };
    },
    async stopLive() {
      calls.stopLive++;
      return true;
    },
    async shot(opts) {
      calls.shot.push(opts);
      return { data: PNG, size: { format: 'png', width: 720, height: 1280 } };
    },
    async tap(x, y, opts) {
      calls.tap.push({ x, y, opts });
      return true;
    },
    async swipe(from, to, durationMs, opts) {
      calls.swipe.push({ from, to, durationMs, opts });
      return true;
    },
    ...overrides,
  };
}

// ------------------------------------------------------------ 纯函数：来源与令牌

test('checkOrigin: 写操作才校验，GET 一律放行', () => {
  assert.equal(checkOrigin({ method: 'GET', headers: {} }), null);
  assert.equal(checkOrigin({ method: 'POST', headers: {} }), null, '没有 Origin（脚本/curl）放行');
  assert.equal(checkOrigin({ method: 'POST', headers: { origin: 'null' } }), null);
});

test('checkOrigin: 本机来源放行，跨站来源拒绝', () => {
  for (const ok of [
    'http://127.0.0.1:8848',
    'http://localhost:8848',
    'http://127.0.0.1',
  ]) {
    assert.equal(checkOrigin({ method: 'POST', headers: { origin: ok } }), null, `${ok} 应放行`);
  }
  for (const bad of ['https://evil.example', 'http://192.168.1.9:8848']) {
    const err = checkOrigin({ method: 'POST', headers: { origin: bad } });
    assert.ok(err, `${bad} 应被拒绝`);
    assert.match(err, /拒绝跨站写请求/);
  }
  assert.ok(checkOrigin({ method: 'POST', headers: { origin: '不是URL' } }), '无法解析的来源应拒绝');
});

test('checkOrigin: --allow-remote（监听 0.0.0.0）时放行局域网来源', () => {
  const req = { method: 'POST', headers: { origin: 'http://192.168.1.9:8848' } };
  assert.equal(checkOrigin(req, { host: '0.0.0.0' }), null, '显式开了远程访问就允许局域网');
  assert.equal(checkOrigin(req, { host: '127.0.0.1' }), null === null ? checkOrigin(req, { host: '127.0.0.1' }) : null);
  assert.ok(checkOrigin(req, { host: '127.0.0.1' }), '默认监听时局域网来源应被拒');
});

test('checkToken: 未配置令牌时不校验；配置后要求 X-Token', () => {
  assert.equal(checkToken({ headers: {} }, null), null);
  assert.equal(checkToken({ headers: {} }, ''), null);
  assert.equal(checkToken({ headers: { 'x-token': 'abc' } }, 'abc'), null);
  // 头名不区分大小写（回归：早先只查小写键名，直接调用时会漏判）
  assert.equal(checkToken({ headers: { 'X-Token': 'abc' } }, 'abc'), null);
  assert.equal(checkToken({ headers: { 'X-TOKEN': 'abc' } }, 'abc'), null);
  assert.match(checkToken({ headers: {} }, 'abc'), /X-Token/);
  assert.match(checkToken({ headers: { 'x-token': '错' } }, 'abc'), /X-Token/);
});

// ------------------------------------------------------------ 真实 HTTP

let server = null;
let runner = null;
let base = '';

test.before(async () => {
  events.resetForTest();
  runner = makeDeviceRunner();
  server = await startWebServer({
    config,
    logger: silent,
    runner,
    port: 0,
    appVersion: '9.9.9',
  });
  base = server.url.replace(/\/$/, '');
});

test.after(async () => {
  await server?.close();
});

const get = (p, init) => fetch(base + p, init);
const postJson = (p, body, headers = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const waitIdle = async () => {
  for (let i = 0; i < 100 && events.ext.phase !== 'idle'; i++) await sleep(10);
  events.resetForTest();
};

test('GET /api/live/shot: 返回 PNG 与尺寸头', async () => {
  await waitIdle();
  const r = await get('/api/live/shot?instance=0');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-image-width'), '720');
  assert.equal(r.headers.get('x-image-height'), '1280');
  assert.equal(r.headers.get('cache-control')?.includes('no-store'), true);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf[0], 0x89);
  assert.equal(buf.length, PNG.length);
  assert.deepEqual(runner.calls.shot.at(-1), { instance: 0 });
});

test('GET /api/live/shot: 截图失败时 503 且带原因（不是 500）', async () => {
  const bad = makeDeviceRunner({
    shot: async () => {
      throw new Error('模拟器未启动');
    },
  });
  const s = await startWebServer({ config, logger: silent, runner: bad, port: 0 });
  try {
    const r = await fetch(s.url.replace(/\/$/, '') + '/api/live/shot');
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /模拟器未启动/);
  } finally {
    await s.close();
  }
});

test('GET /api/live/shot: 空截图数据时 503', async () => {
  const bad = makeDeviceRunner({ shot: async () => ({ data: Buffer.alloc(0), size: null }) });
  const s = await startWebServer({ config, logger: silent, runner: bad, port: 0 });
  try {
    const r = await fetch(s.url.replace(/\/$/, '') + '/api/live/shot');
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /空数据|长度为 0/);
  } finally {
    await s.close();
  }
});

test('POST /api/live/start 与 /api/live/stop', async () => {
  await waitIdle();
  const r1 = await postJson('/api/live/start', { instance: 1 });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).live, true);
  assert.deepEqual(runner.calls.startLive.at(-1), { instance: 1 });

  const r2 = await postJson('/api/live/stop');
  assert.equal(r2.status, 200);
  assert.equal(runner.calls.stopLive, 1);
});

test('POST /api/live/start: 执行层拒绝时返回 409', async () => {
  const bad = makeDeviceRunner({
    startLive: async () => {
      throw new Error('任务运行期间不能打开实时画面');
    },
  });
  const s = await startWebServer({ config, logger: silent, runner: bad, port: 0 });
  try {
    const r = await fetch(s.url.replace(/\/$/, '') + '/api/live/start', { method: 'POST' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /不能打开实时画面/);
  } finally {
    await s.close();
  }
});

test('POST /api/input/tap: 正常点击与坐标校验', async () => {
  await waitIdle();
  const ok = await postJson('/api/input/tap', { x: 649.4, y: 1255.6, instance: 0 });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).tapped, [649, 1256]);
  assert.equal(runner.calls.tap.at(-1).x, 649.4, '执行层拿到原始坐标，取整由执行层负责');
  assert.deepEqual(runner.calls.tap.at(-1).opts, { instance: 0 });

  for (const body of [{}, { x: 1 }, { y: 2 }, { x: '1', y: 2 }, { x: -1, y: 0 }]) {
    const r = await postJson('/api/input/tap', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} 应当 400`);
  }
});

test('POST /api/input/tap: 任务运行期间返回 409', async () => {
  const bad = makeDeviceRunner({
    tap: async () => {
      throw new Error('任务运行期间不能手动操作');
    },
  });
  const s = await startWebServer({ config, logger: silent, runner: bad, port: 0 });
  try {
    const r = await fetch(s.url.replace(/\/$/, '') + '/api/input/tap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1, y: 2 }),
    });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /不能手动操作/);
  } finally {
    await s.close();
  }
});

test('POST /api/input/swipe: 参数校验与正常滑动', async () => {
  await waitIdle();
  const ok = await postJson('/api/input/swipe', { from: [10, 20], to: [30, 40], durationMs: 500 });
  assert.equal(ok.status, 200);
  assert.deepEqual(runner.calls.swipe.at(-1).from, [10, 20]);
  assert.equal(runner.calls.swipe.at(-1).durationMs, 500);

  // 过小的时长会被抬到下限，避免点成滑
  await postJson('/api/input/swipe', { from: [1, 2], to: [3, 4], durationMs: 1 });
  assert.equal(runner.calls.swipe.at(-1).durationMs, 50);

  for (const body of [{}, { from: [1, 2] }, { from: 1, to: 2 }, { from: [1], to: [2] }, { from: ['a', 'b'], to: [1, 2] }]) {
    const r = await postJson('/api/input/swipe', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} 应当 400`);
  }
});

test('GET /api/device: 返回实例列表与当前设备态', async () => {
  const r = await get('/api/device');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.instances), 'instances 必须是数组（解析失败时为空数组）');
  assert.ok('current' in j);
  for (const i of j.instances) {
    assert.ok(Number.isInteger(i.index));
    assert.match(i.address, /^127\.0\.0\.1:\d+$/);
  }
});

test('写操作跨站来源被 403 拒绝（GET 不受影响）', async () => {
  // GET 带跨站 Origin 也应放行
  const g = await get('/api/device', { headers: { origin: 'https://evil.example' } });
  assert.equal(g.status, 200);

  for (const p of ['/api/run', '/api/input/tap', '/api/live/start']) {
    const r = await postJson(p, { x: 1, y: 2 }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403, `${p} 跨站写请求应当被拒绝`);
    assert.match((await r.json()).error, /拒绝跨站写请求/);
  }
});

test('令牌校验：配置令牌后缺 X-Token 的写请求被 401 拒绝，带对则放行', async () => {
  const s = await startWebServer({
    config,
    logger: silent,
    runner: makeDeviceRunner(),
    port: 0,
    token: 'secret-token',
  });
  try {
    const b = s.url.replace(/\/$/, '');
    const noToken = await fetch(b + '/api/live/stop', { method: 'POST' });
    assert.equal(noToken.status, 401);
    assert.match((await noToken.json()).error, /X-Token/);

    const wrong = await fetch(b + '/api/live/stop', {
      method: 'POST',
      headers: { 'x-token': 'nope' },
    });
    assert.equal(wrong.status, 401);

    const right = await fetch(b + '/api/live/stop', {
      method: 'POST',
      headers: { 'x-token': 'secret-token' },
    });
    assert.equal(right.status, 200);

    // GET 不需要令牌
    assert.equal((await fetch(b + '/api/device')).status, 200);
  } finally {
    await s.close();
  }
});

test('没有实时画面能力时返回 501 而不是崩', async () => {
  const bare = { getRunState: () => events.buildRunState(), async start() {}, async stop() {} };
  const s = await startWebServer({ config, logger: silent, runner: bare, port: 0 });
  try {
    const b = s.url.replace(/\/$/, '');
    assert.equal((await fetch(b + '/api/live/shot')).status, 501);
    assert.equal((await fetch(b + '/api/live/start', { method: 'POST' })).status, 501);
    assert.equal((await fetch(b + '/api/input/tap', { method: 'POST' })).status, 501);
  } finally {
    await s.close();
  }
});

test('debug/ 下的真机截图能通过 /api/shot 取回（端到端链路自检）', async (t) => {
  const probe = path.join(PATHS.onError, '__api_test__.png');
  fs.mkdirSync(PATHS.onError, { recursive: true });
  fs.writeFileSync(probe, PNG);
  try {
    const r = await get('/api/shot?path=' + encodeURIComponent('on_error/__api_test__.png'));
    assert.equal(r.status, 200);
    assert.equal(Buffer.from(await r.arrayBuffer()).length, PNG.length);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

// ------------------------------------------------------------ 任务集接口

const readTasks = async () => (await get('/api/tasks')).json();
const postJson2 = (p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('任务集：POST 新建后能读回，且落盘为合法 JSON', async () => {
  const before = await readTasks();
  const created = await postJson2('/api/tasks/presets', { name: '接口测试集' });
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.equal(body.saved, true);
  assert.ok(body.presets.length >= 1);

  const after = await readTasks();
  assert.ok(after.exists, '保存后应当存在任务集文件');
  assert.equal(after.errors.length, 0);
  assert.ok(after.presets.some((p) => p.name === '接口测试集'));

  // 校验磁盘内容确实是这份
  const disk = JSON.parse(fs.readFileSync(PATHS.tasksFile, 'utf8'));
  assert.ok(Array.isArray(disk.presets));
  assert.ok(disk.presets.some((p) => p.name === '接口测试集'));

  // 清理：删掉刚建的
  const id = after.presets.find((p) => p.name === '接口测试集').id;
  const del = await fetch(base + '/api/tasks/presets/' + id, { method: 'DELETE' });
  assert.equal(del.status, 200);
  void before;
});

test('任务集：id 重复返回 409，不存在的 preset 返回 404', async () => {
  const created = await postJson2('/api/tasks/presets', { id: 'dup-probe' });
  assert.equal(created.status, 200);
  const again = await postJson2('/api/tasks/presets', { id: 'dup-probe' });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /已存在/);

  assert.equal((await fetch(base + '/api/tasks/presets/绝对不存在', { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(base + '/api/tasks/presets/dup-probe', { method: 'DELETE' })).status, 200);
});

test('任务集：步骤排序 / 开关 / 超时，以及非法操作返回 422', async () => {
  await postJson2('/api/tasks/presets', { id: 'steps-probe' });
  try {
    const detail = await readTasks();
    const p = detail.presets.find((x) => x.id === 'steps-probe');
    assert.ok(p, '刚建的任务集应当能读到');
    assert.ok(p.steps.length >= 2, '新建任务集默认带上已发现的模块');
    const order = p.steps.map((s) => s.raw);

    // 反转顺序
    const reversed = [...order].reverse();
    const r1 = await postJson2('/api/tasks/presets/steps-probe/steps', {
      ops: [{ op: 'reorder', order: reversed }],
    });
    assert.equal(r1.status, 200);
    const after1 = (await r1.json()).presets.find((x) => x.id === 'steps-probe');
    assert.deepEqual(after1.steps.map((s) => s.raw), reversed, '顺序应当真的变了');

    // 关闭第一个 + 设超时
    const r2 = await postJson2('/api/tasks/presets/steps-probe/steps', {
      ops: [
        { op: 'toggle', entry: reversed[0], enabled: false },
        { op: 'timeout', entry: reversed[1], timeoutMs: 4321 },
      ],
    });
    assert.equal(r2.status, 200);
    const after2 = (await r2.json()).presets.find((x) => x.id === 'steps-probe');
    assert.equal(after2.steps[0].enabled, false);
    assert.equal(after2.steps[1].timeoutMs, 4321);

    // 集合不一致的排序必须被拒，且不落盘
    const diskBefore = fs.readFileSync(PATHS.tasksFile, 'utf8');
    const r3 = await postJson2('/api/tasks/presets/steps-probe/steps', {
      ops: [{ op: 'reorder', order: [reversed[0]] }],
    });
    assert.equal(r3.status, 422);
    assert.ok((await r3.json()).errors.length > 0);
    assert.equal(fs.readFileSync(PATHS.tasksFile, 'utf8'), diskBefore, '被拒时不应改动文件');

    // 未知 op
    const r4 = await postJson2('/api/tasks/presets/steps-probe/steps', { ops: [{ op: '飞' }] });
    assert.equal(r4.status, 422);
  } finally {
    await fetch(base + '/api/tasks/presets/steps-probe', { method: 'DELETE' });
  }
});

test('任务集：全部步骤关闭时执行返回 400（不会空跑）', async () => {
  await postJson2('/api/tasks/presets', { id: 'empty-probe' });
  try {
    const detail = await readTasks();
    const p = detail.presets.find((x) => x.id === 'empty-probe');
    const ops = p.steps.map((s) => ({ op: 'toggle', entry: s.raw, enabled: false }));
    if (ops.length > 0) {
      const r = await postJson2('/api/tasks/presets/empty-probe/steps', { ops });
      assert.equal(r.status, 200);
    }
    const run = await postJson2('/api/tasks/presets/empty-probe/run', { instance: 0 });
    assert.equal(run.status, 400);
    assert.match((await run.json()).error, /没有任何启用的步骤/);
  } finally {
    await fetch(base + '/api/tasks/presets/empty-probe', { method: 'DELETE' });
  }
});

// ------------------------------------------------------------ 流水线接口

test('GET /api/pipelines: 概览含文档与节点索引', async () => {
  const r = await get('/api/pipelines');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.docs.length >= 4);
  assert.ok(j.totalNodes > 5);
  assert.ok(Array.isArray(j.orphans));
  const common = j.docs.find((d) => d.base === '_common');
  assert.equal(common.shared, true);
});

test('GET /api/pipelines/:base: 返回正文、校验与节点详情字段', async () => {
  const r = await get('/api/pipelines/' + encodeURIComponent('_common'));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.base, '_common');
  assert.match(j.text, /回到主界面/);
  assert.ok(j.mtime > 0);
  assert.ok(Array.isArray(j.errors) && Array.isArray(j.warnings));
  // 假 runner 没实现节点详情：JSON 会丢掉值为 undefined 的字段，所以只要求「不报错」
  assert.ok(j.details === undefined || j.details === null || typeof j.details === 'object');
});

test('GET /api/pipelines/:base: 提供了节点详情实现时能带出框架合并后的字段', async () => {
  const fake = makeDeviceRunner({
    async pipelineNodeDetails(names) {
      return Object.fromEntries(names.map((n) => [n, { ok: true, merged: { timeout: 1234 } }]));
    },
  });
  const s = await startWebServer({ config, logger: silent, runner: fake, port: 0 });
  try {
    const b = s.url.replace(/\/$/, '');
    const j = await (await fetch(b + '/api/pipelines/' + encodeURIComponent('_common'))).json();
    assert.ok(j.details, '应当带上节点详情');
    const names = Object.keys(j.details);
    assert.deepEqual(names, j.nodes, '节点详情应当覆盖文档里的全部节点');
    assert.equal(j.details[names[0]].merged.timeout, 1234);
  } finally {
    await s.close();
  }
});

test('GET /api/pipelines/:base: 节点详情实现抛错时不影响正文与校验', async () => {
  const fake = makeDeviceRunner({
    async pipelineNodeDetails() {
      throw new Error('资源加载失败');
    },
  });
  const s = await startWebServer({ config, logger: silent, runner: fake, port: 0 });
  try {
    const b = s.url.replace(/\/$/, '');
    const r = await fetch(b + '/api/pipelines/' + encodeURIComponent('_common'));
    assert.equal(r.status, 200, '详情失败不该让整个请求挂掉');
    const j = await r.json();
    assert.ok(j.text, '正文仍应返回');
    assert.ok(Array.isArray(j.errors));
  } finally {
    await s.close();
  }
});

test('GET /api/pipelines/:base: 不存在的文件与非法名', async () => {
  assert.equal((await get('/api/pipelines/绝对不存在')).status, 404);
  const r = await get('/api/pipelines/' + encodeURIComponent('../package'));
  assert.ok([400, 404].includes(r.status), `穿越路径应当被拒，实际 ${r.status}`);
});

test('POST /api/pipelines/:base: 只校验不保存，坏引用能定位', async () => {
  const before = fs.readFileSync(path.join(PATHS.pipeline, '_common.json'), 'utf8');
  const r = await postJson2('/api/pipelines/_common', {
    text: JSON.stringify({ A: { next: ['根本不存在的节点'] } }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.errors.length, 1);
  assert.equal(j.errors[0].path, 'A.next');
  assert.match(j.errors[0].message, /引用的节点不存在/);
  assert.equal(fs.readFileSync(path.join(PATHS.pipeline, '_common.json'), 'utf8'), before, '校验接口不应落盘');
});

test('PUT /api/pipelines/:base: 坏引用必须 422 且不落盘（回归）', async () => {
  // 这是真正的漏网之鱼：早先 validatePipelineDoc 的参数名与调用方不一致，
  // 于是**保存路径上的引用校验被静默跳过**，坏引用照样写进磁盘。
  const file = path.join(PATHS.pipeline, '_common.json');
  const before = fs.readFileSync(file, 'utf8');

  const r = await fetch(base + '/api/pipelines/_common', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: JSON.stringify({ A: { next: ['根本不存在的节点'] } }) }),
  });
  assert.equal(r.status, 422, `坏引用必须被拒，实际 ${r.status}`);
  assert.match((await r.json()).error, /校验未通过/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '被拒时文件必须保持原样');

  // 非法 JSON 也要拒
  const bad = await fetch(base + '/api/pipelines/_common', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '{ 不是 json' }),
  });
  assert.equal(bad.status, 422);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  // 非法的文件基名要拒
  const evil = await fetch(base + '/api/pipelines/' + encodeURIComponent('../package'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '{}' }),
  });
  assert.ok([422, 400, 404].includes(evil.status), `穿越路径应当被拒，实际 ${evil.status}`);
});

test('PUT /api/pipelines/:base: mtime 冲突返回 409', async () => {
  const file = path.join(PATHS.pipeline, '_common.json');
  const before = fs.readFileSync(file, 'utf8');
  const r = await fetch(base + '/api/pipelines/_common', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: before, mtime: 1 }),
  });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /已被外部修改/);
});

test('PUT /api/pipelines/:base: 缺 text 返回 400', async () => {
  const r = await fetch(base + '/api/pipelines/_common', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

// ------------------------------------------------------------ 配置接口

test('GET /api/config: 返回当前配置与校验结果', async () => {
  const r = await get('/api/config');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.config.game.package);
  assert.ok(Array.isArray(j.errors) && Array.isArray(j.warnings));
  assert.match(j.file, /config\.json$/);
});

test('PUT /api/config: 非法配置返回 422 且不落盘', async () => {
  const before = fs.readFileSync(PATHS.configFile, 'utf8');
  const r = await fetch(base + '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: { mumu: { basePort: 0 } } }),
  });
  assert.equal(r.status, 422);
  assert.ok((await r.json()).errors.length > 0);
  assert.equal(fs.readFileSync(PATHS.configFile, 'utf8'), before);

  const bad = await fetch(base + '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
});

test('PUT /api/config: 合法配置会落盘、生成备份，并回写内存配置', async () => {
  const { config: real } = JSON.parse(
    JSON.stringify({ config: (await (await get('/api/config')).json()).config }),
  );
  const before = fs.readFileSync(PATHS.configFile, 'utf8');
  const tweaked = { ...real, runtime: { ...real.runtime, taskTimeoutMs: 123456 } };

  try {
    const r = await fetch(base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: tweaked }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.saved, true);
    assert.ok(j.backup, '应当生成备份');

    const disk = JSON.parse(fs.readFileSync(PATHS.configFile, 'utf8'));
    assert.equal(disk.runtime.taskTimeoutMs, 123456);

    // 内存里的配置也应更新（/api/state 读的是执行层持有的那份）
    const st = await (await get('/api/state')).json();
    assert.equal(st.config.runtime.taskTimeoutMs, 123456);
  } finally {
    fs.writeFileSync(PATHS.configFile, before);
  }
});

// ------------------------------------------------------------ 调度接口

test('GET /api/schedule: 未启动调度器时给出 enabled:false 而不是报错', async () => {
  const r = await get('/api/schedule');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.enabled, false);
  assert.deepEqual(j.jobs, []);
  assert.deepEqual(j.history, []);
});

test('GET /api/schedule: 注入的调度器能给出作业与下次触发', async () => {
  const fake = {
    jobs: () => [{ presetId: 'a', name: 'A', cron: '0 8 * * *', ok: true, nextText: '2026-09-23 08:00' }],
    getHistory: () => [{ ts: 1, presetId: 'a', result: 'fired' }],
    tick: async () => ({ fired: 0 }),
  };
  const s = await startWebServer({ config, logger: silent, runner: makeDeviceRunner(), port: 0, scheduler: fake });
  try {
    const b = s.url.replace(/\/$/, '');
    const j = await (await fetch(b + '/api/schedule')).json();
    assert.equal(j.enabled, true);
    assert.equal(j.jobs.length, 1);
    assert.equal(j.jobs[0].nextText, '2026-09-23 08:00');
    assert.equal(j.history.length, 1);

    const t = await fetch(b + '/api/schedule/check', { method: 'POST' });
    assert.equal(t.status, 200);
    assert.equal((await t.json()).fired, 0);
  } finally {
    await s.close();
  }
});

test('POST /api/schedule/check: 没有调度器时 503', async () => {
  const r = await postJson2('/api/schedule/check');
  assert.equal(r.status, 503);
});

// ------------------------------------------------------------ 任务集写入仍受写守卫保护

test('任务集与流水线的写接口同样受跨站来源与令牌保护', async () => {
  const cross = await fetch(base + '/api/tasks/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ id: 'cross-probe' }),
  });
  assert.equal(cross.status, 403);

  const crossPipeline = await fetch(base + '/api/pipelines/_common', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ text: '{}' }),
  });
  assert.equal(crossPipeline.status, 403);

  const crossConfig = await fetch(base + '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ config: {} }),
  });
  assert.equal(crossConfig.status, 403);
});
