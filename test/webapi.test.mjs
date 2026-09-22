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
