import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startWebServer, resolveArtifact, listArtifacts, buildState } from '../src/web.mjs';
import { loadConfig, PATHS } from '../src/config.mjs';
import * as events from '../src/events.mjs';

const { config } = loadConfig();

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** 假的 runner：start 会一直挂着，直到 stop 被调用。 */
function makeFakeRunner() {
  let release = null;
  return {
    calls: [],
    stops: 0,
    getRunState: () => ({ ...events.state }),
    async start(opts) {
      this.calls.push(opts);
      events.beginRun(opts.tasks ?? ['(auto)']);
      await new Promise((r) => {
        release = r;
      });
      events.endRun();
    },
    async stop() {
      this.stops++;
      release?.();
      release = null;
    },
  };
}

let server = null;
let runner = null;
let base = '';

before(async () => {
  events.resetForTest();
  runner = makeFakeRunner();
  server = await startWebServer({
    config,
    logger: silent,
    runner,
    port: 0, // 让系统分配空闲端口，避免和真实 ui 冲突
    appVersion: '9.9.9',
  });
  base = server.url.replace(/\/$/, '');
});

after(async () => {
  await server?.close();
});

const get = (p) => fetch(base + p);
const post = (p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ------------------------------------------------------------ 路径防护（纯函数）

test('resolveArtifact: 只接受 debug/ 内的 .png', () => {
  assert.equal(resolveArtifact('../../package.json'), null, '非 png');
  assert.equal(resolveArtifact('../secret.png'), null, '越出 debug/');
  assert.equal(resolveArtifact('/etc/passwd'), null);
  assert.equal(resolveArtifact(''), null);
  assert.equal(resolveArtifact(null), null);
  assert.equal(resolveArtifact('on_error/../../x.png'), null);

  const ok = resolveArtifact('on_error/a.png');
  assert.ok(ok, 'debug/ 内的 png 应当通过');
  assert.ok(path.resolve(ok).startsWith(path.resolve(PATHS.debug) + path.sep));
});

test('listArtifacts: 返回两个数组，按时间倒序', () => {
  const a = listArtifacts();
  assert.ok(Array.isArray(a.onError));
  assert.ok(Array.isArray(a.draws));
  for (const arr of [a.onError, a.draws]) {
    for (let i = 1; i < arr.length; i++) {
      assert.ok(arr[i - 1].mtime >= arr[i].mtime, '应按 mtime 倒序');
    }
  }
});

test('buildState: 含版本、实例地址与模块列表', () => {
  const s = buildState(config, '1.2.3');
  assert.equal(s.app.version, '1.2.3');
  assert.equal(s.config.package, config.game.package);
  assert.ok(s.config.instances.length > 0);
  assert.match(s.config.instances[0].address, /^127\.0\.0\.1:\d+$/);
  assert.ok(Array.isArray(s.modules));
  assert.ok(s.modules.length > 0, '应当能发现模块');
  assert.ok('running' in s.run);
});

// ------------------------------------------------------------ HTTP 路由

test('GET /: 返回单页 HTML', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  assert.match(html, /无尽冬日/);
  assert.match(html, /EventSource/);
  assert.ok(!/https?:\/\/(cdn|unpkg|jsdelivr)/.test(html), '不应引用任何 CDN');
});

test('GET /api/state: 返回状态快照', async () => {
  await ensureIdle();
  const r = await get('/api/state');
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.app.version, '9.9.9');
  assert.ok(Array.isArray(s.modules) && s.modules.length > 0);
  assert.equal(s.run.running, false);
});

test('GET /api/artifacts: 返回产物列表', async () => {
  const r = await get('/api/artifacts');
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.ok(Array.isArray(a.onError) && Array.isArray(a.draws));
});

test('GET /api/shot: 拒绝目录穿越与非 png', async () => {
  for (const p of ['../package.json', '../../package.json', 'on_error/../../x.png', '/etc/passwd']) {
    const r = await get('/api/shot?path=' + encodeURIComponent(p));
    assert.equal(r.status, 400, `${p} 应被拒绝`);
  }
});

test('GET /api/shot: 不存在的文件返回 404', async () => {
  const r = await get('/api/shot?path=' + encodeURIComponent('on_error/绝对不存在.png'));
  assert.equal(r.status, 404);
});

test('GET /api/shot: 能取到 debug/ 下的真实图片', async () => {
  const probe = path.join(PATHS.onError, '__webtest__.png');
  fs.mkdirSync(PATHS.onError, { recursive: true });
  fs.writeFileSync(probe, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    const r = await get('/api/shot?path=' + encodeURIComponent('on_error/__webtest__.png'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf[0], 0x89);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('未知路由返回 404', async () => {
  const r = await get('/api/nope');
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.match(j.error, /未知路由/);
});

// ------------------------------------------------------------ 运行控制
// 事件状态是全局单例，用例之间会互相影响，所以每个用例都显式把状态归零。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, label) {
  for (let i = 0; i < 100 && !pred(); i++) await sleep(10);
  assert.ok(pred(), label);
}

/** 释放假 runner 并把事件状态归零，保证下一个用例从空闲开始。 */
async function ensureIdle() {
  if (events.state.running) {
    await post('/api/stop').catch(() => {});
    for (let i = 0; i < 100 && events.state.running; i++) await sleep(10);
  }
  events.resetForTest();
}

test('POST /api/stop: 空闲时返回 409', async () => {
  await ensureIdle();
  const r = await post('/api/stop');
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.match(j.error, /没有任务在运行/);
});

test('POST /api/run: 启动返回 202，运行中再启动返回 409', async () => {
  await ensureIdle();
  const before = runner.calls.length;

  const r1 = await post('/api/run', { tasks: ['联盟日常'], instance: 0, retry: 1 });
  assert.equal(r1.status, 202);
  const j1 = await r1.json();
  assert.equal(j1.started, true);
  // 接口对外给的是「已解析的真实节点名」，顺序即执行顺序
  assert.deepEqual(j1.options.entries, ['联盟日常']);
  assert.equal(j1.options.retry, 1);
  assert.equal(j1.options.instance, 0);

  await waitFor(() => events.state.running, 'runner 应已进入运行态');

  const r2 = await post('/api/run', { tasks: ['x'] });
  assert.equal(r2.status, 409, '运行中不应允许再次启动');
  assert.match((await r2.json()).error, /已有任务在运行中/);

  assert.deepEqual(runner.calls[before].entries, ['联盟日常']);
  await ensureIdle();
});

test('POST /api/run: steps 形态保留顺序与开关，并透传单步超时', async () => {
  await ensureIdle();
  const before = runner.calls.length;

  const r = await post('/api/run', {
    instance: 0,
    steps: [
      { entry: '回到主界面', enabled: true, timeoutMs: 1234 },
      { entry: '联盟日常', enabled: false },
      { entry: '启动游戏', enabled: true },
    ],
  });
  assert.equal(r.status, 202);
  const opts = (await r.json()).options;

  assert.deepEqual(opts.entries, ['回到主界面', '启动游戏'], '关闭的步骤必须被剔除，顺序保持');
  assert.deepEqual(opts.stepTimeouts, { 回到主界面: 1234 });
  assert.deepEqual(runner.calls[before].entries, ['回到主界面', '启动游戏']);

  await ensureIdle();
});

test('POST /api/run: 全部步骤关闭时返回 400 而不是空跑', async () => {
  await ensureIdle();
  const r = await post('/api/run', { steps: [{ entry: '联盟日常', enabled: false }] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /没有要执行的任务/);
});

test('POST /api/run: 无法识别的运行时参数被剔除，不会传进执行层', async () => {
  await ensureIdle();
  const before = runner.calls.length;
  const r = await post('/api/run', {
    tasks: ['联盟日常'],
    runtime: { saveFailureShot: true, 乱写的: 1, taskTimeoutMs: 'x' },
  });
  assert.equal(r.status, 202);
  assert.deepEqual(runner.calls[before].runtime, { saveFailureShot: true });
  await ensureIdle();
});

test('POST /api/run: runner 调用 onReady 后 phase 从 starting 变成 running', async () => {
  await ensureIdle();

  let release = null;
  const readyRunner = {
    calls: 0,
    getRunState: () => ({ ...events.state }),
    async start(opts) {
      this.calls++;
      await sleep(30); // 模拟连设备
      opts.onReady?.(); // 模拟 cmdUi 在 runTasks 之前通知
      await new Promise((r) => {
        release = r;
      });
    },
    async stop() {
      release?.();
    },
  };

  const s3 = await startWebServer({
    config,
    logger: silent,
    runner: readyRunner,
    port: 0,
    appVersion: '9.9.9',
  });
  try {
    const b = s3.url.replace(/\/$/, '');
    await fetch(b + '/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    const early = await (await fetch(b + '/api/state')).json();
    assert.equal(early.run.phase, 'starting', '刚开始时应是 starting');

    for (let i = 0; i < 100; i++) {
      const cur = await (await fetch(b + '/api/state')).json();
      if (cur.run.phase === 'running') break;
      await sleep(10);
    }
    const mid = await (await fetch(b + '/api/state')).json();
    assert.equal(mid.run.phase, 'running', 'onReady 之后应变成 running');
    assert.equal(mid.run.running, true);

    await fetch(b + '/api/stop', { method: 'POST' });
  } finally {
    await s3.close();
  }
  await ensureIdle();
});

test('POST /api/run: 连设备期间（runTasks 还没置位）也必须拦住第二次启动', async () => {
  // 回归测试：之前只看 events.state.running，而它在 runTasks 之前一直是 false，
  // 于是「连模拟器 + 建控制器」的几秒里第二次点击会再起一轮，两个 run 抢同一个设备。
  await ensureIdle();

  let release = null;
  const slowRunner = {
    calls: 0,
    getRunState: () => ({ ...events.state }),
    async start() {
      this.calls++;
      // 刻意不调用 events.beginRun：模拟「还在连设备」的窗口
      await new Promise((r) => {
        release = r;
      });
    },
    async stop() {
      release?.();
    },
  };

  const s2 = await startWebServer({
    config,
    logger: silent,
    runner: slowRunner,
    port: 0,
    appVersion: '9.9.9',
  });
  try {
    const b = s2.url.replace(/\/$/, '');
    const p1 = await fetch(b + '/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: ['联盟日常'] }),
    });
    assert.equal(p1.status, 202);

    // 此刻 runner 挂在 start 里，events.state.running 仍是 false
    await waitFor(() => slowRunner.calls === 1, 'runner 应已收到第一次启动');
    assert.equal(events.state.running, false, '前提：runTasks 还没置位');

    const p2 = await fetch(b + '/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: ['启动游戏'] }),
    });
    assert.equal(p2.status, 409, '准备阶段也必须拦住第二次启动');
    assert.equal(slowRunner.calls, 1, '不应真的启动第二轮');

    const st = await (await fetch(b + '/api/state')).json();
    assert.equal(st.run.running, true, '准备阶段就应显示为运行中');
    assert.equal(st.run.phase, 'starting');

    // 停止：phase 变 stopping，等 start 结算后回到 idle
    const ps = await fetch(b + '/api/stop', { method: 'POST' });
    assert.equal(ps.status, 200);
    for (let i = 0; i < 100; i++) {
      const cur = await (await fetch(b + '/api/state')).json();
      if (cur.run.phase === 'idle') break;
      await sleep(10);
    }
    const after = await (await fetch(b + '/api/state')).json();
    assert.equal(after.run.phase, 'idle');
    assert.equal(after.run.running, false);
  } finally {
    await s2.close();
  }
  await ensureIdle();
});

test('POST /api/run: 非法 JSON 返回 400（空闲时）', async () => {
  await ensureIdle();
  const r = await fetch(base + '/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ 不是 json',
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /JSON/);
});

test('POST /api/stop: 运行中能停止，随后状态回到空闲', async () => {
  await ensureIdle();
  const stopsBefore = runner.stops;

  const r0 = await post('/api/run', { tasks: ['联盟日常'] });
  assert.equal(r0.status, 202);
  await waitFor(() => events.state.running, 'runner 应已进入运行态');

  const r = await post('/api/stop');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).stopping, true);
  assert.equal(runner.stops, stopsBefore + 1);

  await waitFor(() => !events.state.running, '停止后应回到空闲');
  events.resetForTest();
});

test('POST /api/run: 未指定任务时按自动发现展开成真实节点名', async () => {
  await ensureIdle();
  const before = runner.calls.length;
  const r = await post('/api/run', { instance: 0 });
  assert.equal(r.status, 202);
  const opts = (await r.json()).options;
  // 自动发现会把模块按文件名顺序解析成入口节点（不是文件名）
  assert.ok(Array.isArray(opts.entries) && opts.entries.length > 0, JSON.stringify(opts));
  assert.deepEqual(runner.calls[before].entries, opts.entries);
  assert.match(opts.source, /自动发现/);
  await ensureIdle();
});

test('GET /api/state: 运行中时 running 为 true 且带当前任务', async () => {
  await ensureIdle();
  await post('/api/run', { tasks: ['联盟日常'] });
  await waitFor(() => events.state.running, 'runner 应已进入运行态');
  events.setCurrent('联盟日常');

  const s = await (await get('/api/state')).json();
  assert.equal(s.run.running, true);
  assert.equal(s.run.current, '联盟日常');

  await ensureIdle();
});

test('SSE: /api/events 先补发快照，再推送新日志', async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';

  // 读到 snapshot 帧为止
  while (!text.includes('event: snapshot')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  assert.match(text, /event: snapshot/, '应先收到 snapshot');

  // 推一条日志，确认能实时收到
  events.publishLog({ ts: 'x', level: 'info', scope: 'test', message: '来自测试的日志' });
  while (!text.includes('来自测试的日志')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  assert.match(text, /来自测试的日志/, '应收到实时日志');

  ctrl.abort();
});

test('SSE: 新连接能补发历史日志', async () => {
  events.resetForTest();
  events.publishLog({ ts: 'x', level: 'info', scope: 'hist', message: '历史日志内容' });

  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (!text.includes('历史日志内容')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  assert.match(text, /历史日志内容/, '应补发历史日志');
  ctrl.abort();
});
