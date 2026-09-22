/**
 * 本地网页界面：纯 node:http + SSE，零新增依赖，默认只监听 127.0.0.1。
 *
 * 设计要点：
 *  - 运行逻辑通过 `runner` 注入（见下方 WebRunner），因此本模块不依赖设备，
 *    可以用假的 runner 做单元测试。
 *  - 页面是内联的单文件 HTML，没有构建步骤、不引用任何 CDN。
 *  - 截图接口做了目录穿越防护：解析后的路径必须仍在 debug/ 内。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, resolveInstance, pickInstances, sanitizeRuntimeOverrides } from './config.mjs';
import * as events from './events.mjs';
import { discoverModules, resolveEntry, validatePipelines } from './resource.mjs';
import { decideEntries } from './cli-args.mjs';
import { listInstances, ensureInstanceReady } from './device.mjs';

/**
 * @typedef {object} WebRunner
 * @property {() => object} getRunState 当前运行状态
 * @property {(opts: {tasks?: string[], instance?: number, retry?: number}) => Promise<object>} start
 * @property {() => void | Promise<void>} stop
 */

const ARTIFACT_LIMIT = 60;

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** 把 debug/ 下的相对路径解析成绝对路径；越界或非 PNG 返回 null。 */
export function resolveArtifact(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (!/\.png$/i.test(rel)) return null;
  const base = path.resolve(PATHS.debug);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/** 列出 debug/on_error 与 debug/draws 下最近的产物。 */
export function listArtifacts() {
  const pick = (dir, sub) => {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, rel: `${sub}/${f}`, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, ARTIFACT_LIMIT);
  };
  return { onError: pick(PATHS.onError, 'on_error'), draws: pick(PATHS.draws, 'draws') };
}

/** 状态快照（给 /api/state 与 SSE 的首帧用）。 */
export function buildState(config, appVersion, phase = null) {
  const currentPhase = phase ?? events.ext.phase;
  return {
    app: { version: appVersion },
    config: {
      package: config.game?.package ?? null,
      shortSide: config.runtime?.shortSide ?? null,
      runtime: { ...(config.runtime ?? {}) },
      instances: (config.instances ?? []).map((i) => ({
        index: i.index,
        enabled: i.enabled !== false,
        address: resolveInstance(config, i.index).address,
        tasks: i.tasks ?? [],
      })),
    },
    modules: discoverModules(),
    device: events.ext.device,
    schedule: events.ext.schedule,
    runs: events.getRuns(20),
    // phase 覆盖 events.state.running：连设备、建控制器要好几秒，
    // 这段时间 events.state.running 还是 false，只看它会让第二次点击
    // 又启动一轮（实测两个 run 抢同一个模拟器）。
    run: {
      ...events.buildRunState(),
      running: currentPhase !== 'idle' || events.state.running,
      phase: currentPhase,
    },
  };
}

/**
 * 把前端传来的执行请求解析成「真实节点名 + 单步超时」。
 *
 * 支持三种入参（优先级从高到低）：
 *   1. `steps: [{entry, enabled, timeoutMs}]` —— 界面编排用的形态，顺序即执行顺序
 *   2. `tasks: string[]` —— CLI 风格，元素可以是节点名或流水线文件名
 *   3. 都不给 —— 走 config.instances[].tasks，再退回自动发现
 *
 * 解析逻辑复用 cli-args 的 decideEntries，保证界面与 CLI 的优先级完全一致。
 */
export function resolveRunPlan(config, body, logger) {
  const index = Number.isInteger(body.instance) ? body.instance : (config.instances[0]?.index ?? 0);
  const inst = pickInstances(config, index)[0];
  const nodes = listPipelineNodes();

  // 形态 1：显式 steps
  if (Array.isArray(body.steps) && body.steps.length > 0) {
    const entries = [];
    const stepTimeouts = {};
    for (const s of body.steps) {
      if (!s || typeof s.entry !== 'string' || !s.entry) continue;
      if (s.enabled === false) continue;
      const entry = resolveEntry(s.entry, nodes, logger);
      entries.push(entry);
      if (Number.isInteger(s.timeoutMs) && s.timeoutMs > 0) stepTimeouts[entry] = s.timeoutMs;
    }
    return { entries, stepTimeouts, source: 'steps（界面编排）' };
  }

  // 形态 2/3：tasks，或配置里的 tasks，或自动发现
  const tasks =
    Array.isArray(body.tasks) && body.tasks.length > 0 ? body.tasks.join(',') : undefined;
  const { entries, source } = decideEntries(config, inst, { tasks }, nodes, logger);
  return { entries: entries.map((e) => resolveEntry(e, nodes, logger)), stepTimeouts: {}, source };
}

/** 资源里真实存在的节点名（用于校验与解析入口）。读不到就返回空数组。 */
function listPipelineNodes() {
  const nodes = [];
  for (const p of validatePipelines()) {
    if (p.ok) nodes.push(...p.nodes);
  }
  return nodes;
}

// ---------------------------------------------------------------- 写操作守卫

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 写操作的来源校验（防 DNS rebinding）。
 *
 * 背景：服务默认只监听 127.0.0.1，但攻击者可以把自己的域名解析到 127.0.0.1，
 * 让受害者的浏览器**从外部页面**直接对本服务发写请求。浏览器会带上
 * `Origin`，据此判断是不是同源即可拦掉。
 *
 * 放行规则（宁松勿误伤，因为我们本来也没有鉴权）：
 *   - 非写操作（GET 等）不校验
 *   - 没有 Origin（curl、脚本等非浏览器客户端）放行
 *   - 已知的**本机与非浏览器来源**放行：`null`、`file://` 场景
 *   - Origin 的主机名是本机回环地址（127.0.0.1 / localhost / ::1）放行
 *   - 其余一律 403
 *
 * @returns {string|null} 不通过时返回给用户的错误说明
 */
export function checkOrigin(req, { host = '127.0.0.1' } = {}) {
  if (!WRITE_METHODS.has(req.method ?? 'GET')) return null;
  const origin = req.headers?.origin;
  if (!origin || origin === 'null') return null;

  let originHost;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return `请求来源无法识别：${origin}`;
  }

  const localNames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (localNames.has(originHost)) return null;
  // 监听在 0.0.0.0 时允许本机的局域网地址访问（使用者自己开的开关）
  if (host === '0.0.0.0' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(originHost)) {
    return null;
  }

  return `拒绝跨站写请求：来源 ${origin}。界面请通过 http://127.0.0.1 访问`;
}

/**
 * 简易令牌校验（仅在 --allow-remote 时启用）。
 *
 * HTTP 头名**不区分大小写**，所以这里必须自己按小写查找；
 * 直接写 `req.headers['X-Token']` 只在 Node 规范化过请求头时才碰巧能用，
 * 一旦用别的客户端或直接调用本函数就会漏判。
 */
export function checkToken(req, token) {
  if (!token) return null;
  const headers = req.headers ?? {};
  let got;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-token') {
      got = value;
      break;
    }
  }
  if (got === token) return null;
  return '缺少或错误的 X-Token（本服务以 --allow-remote 启动，需要令牌）';
}

// ---------------------------------------------------------------- 路由

async function handle(req, res, ctx) {
  const { config, logger, runner, appVersion, host, token } = ctx;
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  // 只对写操作做来源校验与令牌校验：
  //   - 来源校验防 DNS rebinding（浏览器自动带 Origin）
  //   - 令牌用于 --allow-remote 时保护写操作；GET（例如实时画面每秒轮询截图）
  //     不校验令牌，否则界面每帧都得带令牌，既难用也没必要
  if (WRITE_METHODS.has(req.method ?? 'GET')) {
    const originErr = checkOrigin(req, { host });
    if (originErr) return sendJson(res, 403, { error: originErr });
    const tokenErr = checkToken(req, token);
    if (tokenErr) return sendJson(res, 401, { error: tokenErr });
  }

  /**
   * 切换运行阶段，并立刻通过 SSE 广播，页面不用等轮询。
   * 阶段状态单一来源是 events.ext.phase —— 早先另有一份 ctl.phase，
   * 两份状态会漂移（runner 已经忙了，网页还以为空闲）。
   */
  const setPhase = (phase) => events.setPhase(phase);

  if (req.method === 'GET' && route === '/') {
    return sendText(res, 200, renderPage(), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && route === '/api/state') {
    return sendJson(res, 200, buildState(config, appVersion));
  }

  if (req.method === 'GET' && route === '/api/artifacts') {
    return sendJson(res, 200, listArtifacts());
  }

  if (req.method === 'GET' && route === '/api/shot') {
    const target = resolveArtifact(url.searchParams.get('path'));
    if (!target) return sendJson(res, 400, { error: '非法路径（只允许 debug/ 下的 .png）' });
    if (!fs.existsSync(target)) return sendJson(res, 404, { error: '文件不存在' });
    const buf = fs.readFileSync(target);
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    return res.end(buf);
  }

  if (req.method === 'GET' && route === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // 先补发历史，新连上的页面不会空白
    send('snapshot', buildState(config, appVersion));
    for (const l of events.getLogHistory()) send('log', l);
    for (const n of events.getNodeHistory()) send('node', n);

    const onLog = (e) => send('log', e);
    const onNode = (e) => send('node', e);
    const onTask = (e) => send('task', e);
    const onState = (e) => send('state', e);
    events.bus.on('log', onLog);
    events.bus.on('node', onNode);
    events.bus.on('task', onTask);
    events.bus.on('state', onState);

    const beat = setInterval(() => res.write(': ping\n\n'), 15000);
    beat.unref?.();

    const cleanup = () => {
      clearInterval(beat);
      events.bus.off('log', onLog);
      events.bus.off('node', onNode);
      events.bus.off('task', onTask);
      events.bus.off('state', onState);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return undefined;
  }

  if (req.method === 'POST' && route === '/api/run') {
    // 必须用 events.ext.phase 而不是 events.state.running：后者要等 startRun 才开始置位
    if (events.ext.phase !== 'idle') {
      return sendJson(res, 409, {
        error: `已有任务在${events.ext.phase === 'stopping' ? '停止中' : '运行中'}，请稍候`,
      });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }

    const instance = Number.isInteger(body.instance) ? body.instance : undefined;
    const retry = Number.isInteger(body.retry) ? body.retry : 0;

    // 把「用户点选的东西」解析成真实节点名：顺序即执行顺序。
    // 兼容两种入参：显式 steps（带开关/单步超时）与 CLI 风格的 tasks 列表。
    let plan;
    try {
      plan = resolveRunPlan(config, body, logger);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (plan.entries.length === 0) {
      return sendJson(res, 400, {
        error: '没有要执行的任务：勾选的步骤全部关闭，且没有可自动发现的模块',
      });
    }

    const opts = {
      entries: plan.entries,
      stepTimeouts: plan.stepTimeouts,
      instance,
      retry,
      runtime: sanitizeRuntimeOverrides(body.runtime).clean,
      preset: typeof body.preset === 'string' ? body.preset : undefined,
      presetName: typeof body.presetName === 'string' ? body.presetName : undefined,
      source: plan.source,
    };

    // 先占位再回包，避免「解析完请求到真正开始跑」之间被第二个请求插进来
    setPhase('starting');
    sendJson(res, 202, { started: true, options: { ...opts, entries: opts.entries.slice() } });

    try {
      // onReady 由执行层在「设备就绪、资源已加载、即将开跑」时回调，
      // 用来把阶段从 starting 切到 running
      const result = await runner.start({ ...opts, onReady: () => setPhase('running') });
      if (result && result.ok === false) {
        logger.warn('本次执行有失败的任务，详情见上方汇总');
      }
    } catch (e) {
      logger.error(`网页触发的执行失败：${e.message}`);
      logger.debug(e.stack ?? '');
      events.publishLog({
        ts: new Date().toISOString(),
        level: 'error',
        scope: 'web',
        message: `执行失败：${e.message}`,
      });
    } finally {
      setPhase('idle');
    }
    return undefined;
  }

  if (req.method === 'POST' && route === '/api/stop') {
    if (events.ext.phase === 'idle') {
      return sendJson(res, 409, { error: '当前没有任务在运行' });
    }
    if (events.ext.phase === 'stopping') {
      return sendJson(res, 409, { error: '正在停止中' });
    }
    setPhase('stopping');
    logger.info('收到停止请求，正在中断当前任务');
    try {
      await runner.stop();
      return sendJson(res, 200, { stopping: true });
    } catch (e) {
      // 停不下来就退回 running，别把状态卡在 stopping 上
      setPhase('running');
      return sendJson(res, 500, { error: e.message });
    }
  }

  // ------------------------------------------------------------ 实时画面

  if (req.method === 'GET' && route === '/api/live/shot') {
    if (!runner.shot) return sendJson(res, 501, { error: '执行层未提供截图能力' });
    try {
      // 执行层的截图返回 `{data, size}`；data 已由 controller.screencap 归一成 Buffer
      const shot = await runner.shot({ instance: instanceOf(url) });
      const raw = Buffer.isBuffer(shot) ? shot : shot?.data;
      if (!raw) throw new Error('截图返回空数据');
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (data.length === 0) throw new Error('截图数据长度为 0');
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': data.length,
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-image-width': String(shot?.size?.width ?? ''),
        'x-image-height': String(shot?.size?.height ?? ''),
      });
      return res.end(data);
    } catch (e) {
      // 拿不到画面不是服务端错误：多半是模拟器没开或正忙
      return sendJson(res, 503, { error: e.message });
    }
  }

  if (req.method === 'POST' && route === '/api/live/start') {
    if (!runner.startLive) return sendJson(res, 501, { error: '执行层未提供实时画面能力' });
    let body = {};
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    try {
      await runner.startLive({ instance: instanceOf(url, body) });
      return sendJson(res, 200, { live: true, device: events.ext.device });
    } catch (e) {
      return sendJson(res, 409, { error: e.message });
    }
  }

  if (req.method === 'POST' && route === '/api/live/stop') {
    if (!runner.stopLive) return sendJson(res, 501, { error: '执行层未提供实时画面能力' });
    await runner.stopLive();
    return sendJson(res, 200, { live: false });
  }

  // ------------------------------------------------------------ 手动操作

  if (req.method === 'POST' && route === '/api/input/tap') {
    if (!runner.tap) return sendJson(res, 501, { error: '执行层未提供输入能力' });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
      return sendJson(res, 400, { error: '需要数字类型的 x 与 y' });
    }
    if (body.x < 0 || body.y < 0) {
      return sendJson(res, 400, { error: '坐标不能为负' });
    }
    try {
      await runner.tap(body.x, body.y, { instance: instanceOf(url, body) });
      return sendJson(res, 200, { tapped: [Math.round(body.x), Math.round(body.y)] });
    } catch (e) {
      // 任务运行期间会被执行层拒绝（409）；设备问题也给 409，语义是「现在不行」
      return sendJson(res, 409, { error: e.message });
    }
  }

  if (req.method === 'POST' && route === '/api/input/swipe') {
    if (!runner.swipe) return sendJson(res, 501, { error: '执行层未提供输入能力' });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const from = body.from;
    const to = body.to;
    if (
      !Array.isArray(from) ||
      !Array.isArray(to) ||
      from.length < 2 ||
      to.length < 2 ||
      ![...from, ...to].every((n) => Number.isFinite(n))
    ) {
      return sendJson(res, 400, { error: 'from / to 需要是两个数字的数组，例如 [x,y]' });
    }
    const durationMs = Number.isFinite(body.durationMs) ? Math.max(50, body.durationMs) : 300;
    try {
      await runner.swipe(from, to, durationMs, { instance: instanceOf(url, body) });
      return sendJson(res, 200, { swiped: { from, to, durationMs } });
    } catch (e) {
      return sendJson(res, 409, { error: e.message });
    }
  }

  // ------------------------------------------------------------ 设备

  if (req.method === 'GET' && route === '/api/device') {
    let instances = [];
    let error = null;
    try {
      instances = (await listInstances(config, logger)).map((i) => ({
        index: i.index,
        name: i.name,
        isMain: i.isMain,
        isAndroidStarted: i.isAndroidStarted,
        address: resolveInstance(config, i.index).address,
        adbPort: i.adbPort,
      }));
    } catch (e) {
      error = e.message;
    }
    return sendJson(res, 200, { instances, current: events.ext.device, error });
  }

  if (req.method === 'POST' && route === '/api/device/launch') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const index = Number.isInteger(body.index) ? body.index : 0;
    if (events.ext.phase !== 'idle') {
      return sendJson(res, 409, { error: '任务运行期间不能拉起实例' });
    }
    // 拉起实例会调 MuMuManager 并等待 Android 起来，可能要几十秒 —— 先回 202
    sendJson(res, 202, { launching: index });
    try {
      const ready = await ensureInstanceReady(config, index, logger);
      events.publishDevice({
        ...(events.ext.device ?? {}),
        index,
        ready: true,
        address: ready.address,
        detail: '实例已就绪',
      });
    } catch (e) {
      logger.error(`拉起实例 ${index} 失败：${e.message}`);
      events.publishLog({
        ts: new Date().toISOString(),
        level: 'error',
        scope: 'device',
        message: `拉起实例 ${index} 失败：${e.message}`,
      });
    }
    return undefined;
  }

  return sendJson(res, 404, { error: `未知路由 ${req.method} ${route}` });
}

/** 从查询串或请求体里取实例索引。 */
function instanceOf(url, body = {}) {
  if (Number.isInteger(body.instance)) return body.instance;
  const raw = url.searchParams.get('instance');
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// ---------------------------------------------------------------- 服务

/**
 * 启动网页服务。
 * @returns {Promise<{url: string, port: number, host: string, close: () => Promise<void>}>}
 */
export async function startWebServer({
  config,
  logger,
  runner,
  port = 8848,
  host = '127.0.0.1',
  appVersion = '0.0.0',
  token = null,
}) {
  if (!runner) throw new Error('startWebServer 需要 runner');

  const ctx = { config, logger, runner, appVersion, host, token };
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
      logger?.error(`网页请求出错：${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actual = server.address();
  const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${shownHost}:${actual.port}/`;

  logger?.info(`网页界面已启动：${url}`);
  if (host !== '127.0.0.1') {
    logger?.warn(`注意：服务监听在 ${host}，局域网内其它机器也能访问（无鉴权）`);
  }

  return {
    url,
    port: actual.port,
    host,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// ---------------------------------------------------------------- 页面

function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>无尽冬日 · 日常自动化</title>
<style>
  :root { --bg:#12151a; --panel:#1b1f27; --line:#2b313c; --fg:#dfe5ee; --dim:#8b96a8;
          --ok:#3fb950; --warn:#d29922; --err:#f85149; --info:#58a6ff; --dbg:#8b949e; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:13px/1.5 "Segoe UI",-apple-system,"Microsoft YaHei",sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px;
           border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:5; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  .dim { color:var(--dim); }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--dim); display:inline-block; }
  .dot.on { background:var(--ok); box-shadow:0 0 8px var(--ok); }
  main { display:grid; grid-template-columns:340px 1fr; gap:12px; padding:12px; align-items:start; }
  @media (max-width:900px){ main { grid-template-columns:1fr; } }
  section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; }
  section h2 { font-size:13px; margin:0 0 8px; font-weight:600; color:var(--dim);
               text-transform:uppercase; letter-spacing:.04em; }
  label { display:block; margin:6px 0 3px; color:var(--dim); font-size:12px; }
  select,input[type=number] { width:100%; background:#0e1116; color:var(--fg);
       border:1px solid var(--line); border-radius:5px; padding:5px 7px; font:inherit; }
  .mods { max-height:230px; overflow:auto; border:1px solid var(--line);
          border-radius:5px; padding:6px; background:#0e1116; }
  .mods label { display:flex; gap:7px; align-items:center; color:var(--fg);
                margin:2px 0; cursor:pointer; font-size:12px; }
  .mods .bad { color:var(--err); }
  .row { display:flex; gap:8px; margin-top:10px; }
  button { flex:1; padding:8px; border-radius:6px; border:1px solid var(--line);
           background:#222833; color:var(--fg); font:inherit; font-weight:600; cursor:pointer; }
  button:hover:not(:disabled) { background:#2b323f; }
  button.primary { background:#1f6feb; border-color:#1f6feb; }
  button.primary:hover:not(:disabled) { background:#2b7cf0; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  #log { height:340px; overflow:auto; background:#0e1116; border:1px solid var(--line);
         border-radius:6px; padding:8px; font-family:Consolas,"Cascadia Mono",monospace;
         font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .l-error{color:var(--err)} .l-warn{color:var(--warn)} .l-info{color:var(--fg)}
  .l-debug{color:var(--dbg)} .l-trace{color:var(--dbg)}
  .cur { font-family:Consolas,monospace; font-size:12px; color:var(--info); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td,th { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); }
  .shots { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .shots a { display:block; }
  .shots img { width:96px; border:1px solid var(--line); border-radius:4px; display:block; }
  .empty { color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>无尽冬日 · 日常自动化</h1>
  <span class="dim" id="ver"></span>
  <span class="dim" id="pkg" style="margin-left:auto"></span>
</header>

<main>
  <div>
    <section>
      <h2>运行</h2>
      <label>实例</label>
      <select id="inst"></select>
      <label>模块（不勾选则按文件名顺序跑全部）</label>
      <div class="mods" id="mods"></div>
      <label>失败重试次数</label>
      <input type="number" id="retry" value="0" min="0" max="5">
      <div class="row">
        <button class="primary" id="go">开始</button>
        <button id="stop">停止</button>
      </div>
      <p class="empty" id="hint"></p>
    </section>

    <section style="margin-top:12px">
      <h2>进度</h2>
      <div class="cur" id="cur">空闲</div>
      <table id="results"><tbody></tbody></table>
    </section>
  </div>

  <div>
    <section>
      <h2>实时日志</h2>
      <div id="log"></div>
    </section>
    <section style="margin-top:12px">
      <h2>失败截图 / 识别可视化</h2>
      <div id="shots" class="shots"><span class="empty">暂无</span></div>
    </section>
  </div>
</main>

<script>
var $ = function (id) { return document.getElementById(id); };
var modules = [];

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
  });
}

function addLog(e) {
  var box = $('log');
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  var div = document.createElement('div');
  div.className = 'l-' + (e.level || 'info');
  div.textContent = '[' + (e.level || '').toUpperCase() + '] [' + e.scope + '] ' + e.message;
  box.appendChild(div);
  while (box.childNodes.length > 2000) box.removeChild(box.firstChild);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderMods(list) {
  modules = list;
  var box = $('mods');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<span class="empty">没有发现任何模块</span>'; return; }
  list.forEach(function (m, i) {
    var lab = document.createElement('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = m.entry || '';
    cb.disabled = !m.ok;
    cb.dataset.idx = String(i);
    lab.appendChild(cb);
    var span = document.createElement('span');
    span.className = m.ok ? '' : 'bad';
    span.textContent = m.base + (m.ok ? '  →  ' + m.entry : '  ✘ ' + (m.error || ''));
    lab.appendChild(span);
    box.appendChild(lab);
  });
}

function setRun(run) {
  $('dot').className = 'dot' + (run.running ? ' on' : '');
  $('go').disabled = !!run.running;
  $('stop').disabled = !run.running || run.phase === 'stopping';
  var phaseText = { starting: '正在准备（连接模拟器、加载资源）', stopping: '正在停止' };
  if (run.running) {
    $('cur').textContent = (phaseText[run.phase] || '运行中') +
      (run.current ? '：' + run.current : '') +
      '（' + (run.entries || []).length + ' 个任务）';
  } else {
    $('cur').textContent = run.finishedAt ? '已结束' : '空闲';
  }
  var tb = $('results').querySelector('tbody');
  tb.innerHTML = '';
  (run.results || []).forEach(function (r) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + (r.ok ? '✔' : '✘') + '</td><td>' + esc(r.entry) + '</td><td class="dim">' +
      esc(r.reason || (r.elapsed ? r.elapsed + 's' : '')) + '</td>';
    tb.appendChild(tr);
  });
}

function refreshShots() {
  fetch('/api/artifacts').then(function (r) { return r.json(); }).then(function (a) {
    var box = $('shots');
    var all = (a.onError || []).slice(0, 6).concat((a.draws || []).slice(0, 6));
    if (!all.length) { box.innerHTML = '<span class="empty">暂无</span>'; return; }
    box.innerHTML = '';
    all.forEach(function (f) {
      var link = document.createElement('a');
      link.href = '/api/shot?path=' + encodeURIComponent(f.rel);
      link.target = '_blank';
      link.title = f.name;
      var img = document.createElement('img');
      img.src = link.href;
      img.alt = f.name;
      link.appendChild(img);
      box.appendChild(link);
    });
  }).catch(function () {});
}

function loadState() {
  fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) {
    $('ver').textContent = 'v' + s.app.version;
    $('pkg').textContent = s.config.package + '  短边 ' + s.config.shortSide;
    var sel = $('inst');
    sel.innerHTML = '';
    (s.config.instances || []).forEach(function (i) {
      var o = document.createElement('option');
      o.value = String(i.index);
      o.textContent = '[' + i.index + '] ' + i.address + (i.enabled ? '' : '（已禁用）');
      o.disabled = !i.enabled;
      sel.appendChild(o);
    });
    renderMods(s.modules || []);
    setRun(s.run || {});
    refreshShots();
  }).catch(function (e) { addLog({ level: 'error', scope: 'web', message: '读取状态失败：' + e.message }); });
}

$('go').onclick = function () {
  var tasks = [].slice.call($('mods').querySelectorAll('input:checked'))
    .map(function (c) { return c.value; }).filter(Boolean);
  var body = {
    tasks: tasks.length ? tasks : undefined,
    instance: Number($('inst').value),
    retry: Number($('retry').value) || 0
  };
  $('hint').textContent = '已提交…';
  fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (r) {
      $('hint').textContent = r.code === 202 ? '执行中，日志在下方' : ('未能启动：' + (r.j.error || r.code));
    }).catch(function (e) { $('hint').textContent = '请求失败：' + e.message; });
};

$('stop').onclick = function () {
  fetch('/api/stop', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) { $('hint').textContent = j.error || '正在停止…'; })
    .catch(function (e) { $('hint').textContent = '请求失败：' + e.message; });
};

var es = new EventSource('/api/events');
es.addEventListener('snapshot', function (e) {
  var s = JSON.parse(e.data);
  $('ver').textContent = 'v' + s.app.version;
  $('pkg').textContent = s.config.package + '  短边 ' + s.config.shortSide;
  renderMods(s.modules || []);
  setRun(s.run || {});
});
es.addEventListener('log', function (e) { addLog(JSON.parse(e.data)); });
es.addEventListener('state', function (e) { setRun(JSON.parse(e.data)); });
es.addEventListener('task', function () { refreshShots(); });
es.addEventListener('error', function () {
  if (es.readyState === EventSource.CLOSED) {
    addLog({ level: 'warn', scope: 'web', message: '与服务端的连接已断开' });
  }
});

loadState();
setInterval(refreshShots, 10000);
</script>
</body>
</html>`;
}
