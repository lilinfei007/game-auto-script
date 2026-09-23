/**
 * 本地网页界面：纯 node:http + SSE，零新增依赖，默认只监听 127.0.0.1。
 *
 * 设计要点：
 *  - 运行逻辑通过 `runner` 注入（见下方 WebRunner），因此本模块不依赖设备，
 *    可以用假的 runner 做单元测试。
 *  - 界面有两套：`src/webui/dist` 里的 Vue 控制台（阶段 3，`npm run webui:build`
 *    生成）优先；没有构建产物时回落到本文件底部的内联单页 HTML。两套都不引用
 *    任何 CDN —— 内联页是零依赖，Vue 产物是本地打包的。
 *  - 截图接口做了目录穿越防护：解析后的路径必须仍在 debug/ 内。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  resolveInstance,
  pickInstances,
  sanitizeRuntimeOverrides,
  loadConfig,
  validateConfig,
} from './config.mjs';
import * as events from './events.mjs';
import { discoverModules, resolveEntry, validatePipelines } from './resource.mjs';
import { decideEntries } from './cli-args.mjs';
import { listInstances, ensureInstanceReady } from './device.mjs';
import { backupFile, writeFileAtomic } from './util/fsx.mjs';
import {
  readTaskConfig,
  writeTaskConfig,
  validateTaskConfig,
  describePreset,
  resolvePresetRun,
  applyStepOps,
  getPreset,
  upsertPreset,
  removePreset,
  uniquePresetId,
  blankPreset,
} from './task-config.mjs';
import {
  pipelineStats,
  buildNodeIndex,
  readPipelineDoc,
  validatePipelineDoc,
  writePipelineDoc,
} from './pipeline-edit.mjs';

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

// ---------------------------------------------------------------- 控制台静态资源

/** 控制台构建产物里会出现的扩展名 → content-type；没命中的一律不服务。 */
const WEBUI_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 把 URL 路径解析成控制台目录下的真实文件。
 *
 * - 命中认识的扩展名 → `{ file, fallback:false }`
 * - 路径没有扩展名（SPA 内部路由，例如 `/tasks`）→ `{ file: index.html, fallback:true }`
 * - 越界（`..`、编码后的分隔符、空字节）或扩展名不认识 → `null`
 *
 * 纯函数，便于单测；真正的「存在与否」判断留给调用方。
 */
export function resolveWebuiFile(root, route) {
  if (typeof route !== 'string' || typeof root !== 'string' || route === '') return null;
  let rel;
  try {
    rel = decodeURIComponent(route);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const base = path.resolve(root);
  // 先归一化成以 / 开头的 POSIX 路径，再拼到 base 上：这样 `..` 会先被吃掉，
  // 之后的 startsWith 检查能挡住所有越界写法
  const target = path.resolve(base, `.${path.posix.normalize(`/${rel.replace(/\\/g, '/')}`)}`);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  const ext = path.extname(target).toLowerCase();
  if (ext === '') return { file: path.join(base, 'index.html'), fallback: true };
  if (!WEBUI_MIME[ext]) return null;
  return { file: target, fallback: false };
}

/**
 * 用控制台构建产物响应一个 GET。
 *
 * @returns {boolean} true 表示已经响应（false 时调用方继续走后面的路由）
 */
function serveWebui(res, webuiDir, route) {
  const hit = resolveWebuiFile(webuiDir, route);
  if (!hit) return false;
  const indexHtml = path.join(path.resolve(webuiDir), 'index.html');
  let file = hit.file;
  if (!fs.existsSync(file)) {
    // 带扩展名的资源不存在就是没命中（交给后面 404），
    // 否则前端会把一坨 HTML 当 JS 执行，报错位置离真正原因很远
    if (!hit.fallback) return false;
    file = indexHtml;
    if (!fs.existsSync(file)) return false;
  }
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': WEBUI_MIME[ext] ?? 'application/octet-stream',
    'content-length': buf.length,
    // Vite 产物文件名带内容哈希，可以长缓存；index.html 必须每次校验
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(buf);
  return true;
}

/** 状态快照（给 /api/state 与 SSE 的首帧用）。 */
export function buildState(config, appVersion, phase = null) {
  const currentPhase = phase ?? events.ext.phase;
  const tasks = readTaskConfig();
  const knownNodes = listPipelineNodes();
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
    presets: tasks.config.presets.map((p) => describePreset(p, knownNodes)),
    tasksFile: { exists: tasks.exists, mtime: tasks.mtime, errors: tasks.errors },
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
  const { logger, runner, appVersion, host, token } = ctx;
  // 用 getConfig() 而不是解构出的 config：PUT /api/config 之后内存里的是新对象
  const config = ctx.getConfig ? ctx.getConfig() : ctx.config;
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

  // 控制台：构建产物优先（Vue 版），没构建时回落到下面的内联页。
  // 放在 `/api/*` 之外，所以接口路由不受影响。
  if (req.method === 'GET' && ctx.webuiDir && !route.startsWith('/api/')) {
    if (serveWebui(res, ctx.webuiDir, route)) return undefined;
  }

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

  // ------------------------------------------------------------ 单节点试跑

  if (req.method === 'POST' && route === '/api/nodes/run') {
    if (!runner.runNode) return sendJson(res, 501, { error: '执行层未提供单节点试跑能力' });
    if (events.ext.phase !== 'idle') {
      return sendJson(res, 409, { error: `已有任务在${events.ext.phase === 'stopping' ? '停止中' : '运行中'}，请稍候` });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (typeof body.node !== 'string' || !body.node) {
      return sendJson(res, 400, { error: '需要 node 字段（节点名）' });
    }
    // 试跑会连设备、加载资源，可能要十几秒 —— 先回 202 再干活
    sendJson(res, 202, { started: true, node: body.node });
    try {
      const result = await runner.runNode(body.node, {
        instance: Number.isInteger(body.instance) ? body.instance : undefined,
        timeoutMs: Number.isInteger(body.timeoutMs) ? body.timeoutMs : undefined,
      });
      const ok = result?.ok !== false;
      logger.info(`单节点试跑「${body.node}」${ok ? '成功' : '失败'}`);
      events.publishLog({
        ts: new Date().toISOString(),
        level: ok ? 'info' : 'error',
        scope: 'nodes',
        message: `单节点试跑「${body.node}」${ok ? '成功' : `失败：${result?.results?.[0]?.reason ?? '未知原因'}`}`,
      });
    } catch (e) {
      logger.error(`单节点试跑「${body.node}」失败：${e.message}`);
      events.publishLog({
        ts: new Date().toISOString(),
        level: 'error',
        scope: 'nodes',
        message: `单节点试跑「${body.node}」失败：${e.message}`,
      });
    }
    return undefined;
  }

  // ------------------------------------------------------------ 任务集

  if (route.startsWith('/api/tasks')) {
    return await handleTasks(req, res, url, route, ctx);
  }

  // ------------------------------------------------------------ 流水线编辑

  if (route === '/api/pipelines') {
    const stats = pipelineStats();
    return sendJson(res, 200, { ...stats, index: buildNodeIndex().nodes });
  }

  if (route.startsWith('/api/pipelines/')) {
    return await handlePipeline(req, res, route, ctx);
  }

  // ------------------------------------------------------------ 配置与自检

  if (req.method === 'GET' && route === '/api/config') {
    const { config: current, exists, errors, warnings } = loadConfig();
    return sendJson(res, 200, { config: current, exists, errors, warnings, file: PATHS.configFile });
  }

  if (req.method === 'PUT' && route === '/api/config') {
    return await handleConfigWrite(req, res, ctx);
  }

  if (req.method === 'POST' && route === '/api/doctor') {
    if (!runner.doctor) return sendJson(res, 501, { error: '执行层未提供自检能力' });
    if (events.ext.phase !== 'idle') {
      return sendJson(res, 409, { error: '任务运行期间不能跑环境自检' });
    }
    try {
      const checks = await runner.doctor();
      const fatal = checks.filter((c) => !c.ok && c.fatal);
      return sendJson(res, 200, {
        checks,
        passed: checks.filter((c) => c.ok).length,
        total: checks.length,
        failedFatal: fatal.length,
      });
    } catch (e) {
      return sendJson(res, 500, { error: `自检失败：${e.message}` });
    }
  }

  // ------------------------------------------------------------ 调度

  if (req.method === 'GET' && route === '/api/schedule') {
    const scheduler = ctx.scheduler;
    return sendJson(res, 200, {
      enabled: !!scheduler,
      jobs: scheduler ? scheduler.jobs() : [],
      history: scheduler ? scheduler.getHistory() : [],
      state: events.ext.schedule,
    });
  }

  if (req.method === 'POST' && route === '/api/schedule/check') {
    if (!ctx.scheduler) return sendJson(res, 503, { error: '调度器未启动（用 --no-schedule 启动过？）' });
    const result = await ctx.scheduler.tick();
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: `未知路由 ${req.method} ${route}` });
}

// ---------------------------------------------------------------- 任务集处理器

/** 从 `/api/tasks/presets/:id[/steps|/run]` 里切出 id 与子动作。 */
export function parsePresetPath(route) {
  const rest = route.slice('/api/tasks'.length).replace(/^\/+/, '');
  if (rest === '') return { kind: 'root' };
  const parts = rest.split('/').map((p) => decodeURIComponent(p));
  if (parts[0] !== 'presets') return { kind: 'unknown' };
  if (parts.length === 1) return { kind: 'presets' };
  const id = parts[1];
  if (parts.length === 2) return { kind: 'preset', id };
  if (parts.length === 3 && parts[2] === 'steps') return { kind: 'steps', id };
  if (parts.length === 3 && parts[2] === 'run') return { kind: 'run', id };
  return { kind: 'unknown' };
}

async function handleTasks(req, res, url, route, ctx) {
  const { logger, runner, taskConfig } = ctx;
  const store = taskConfig ?? defaultTaskStore(logger);
  const parsed = parsePresetPath(route);
  const knownNodes = listPipelineNodes();

  const readAll = () => {
    const r = store.read();
    return { ...r, described: r.config.presets.map((p) => describePreset(p, knownNodes)) };
  };

  // GET /api/tasks
  if (req.method === 'GET' && parsed.kind === 'root') {
    const r = readAll();
    return sendJson(res, 200, {
      exists: r.exists,
      file: r.file,
      mtime: r.mtime,
      errors: r.errors,
      warnings: r.warnings,
      defaults: r.config.defaults,
      presets: r.described,
    });
  }

  if (req.method === 'POST' && parsed.kind === 'presets') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const current = store.read();
    const id = typeof body.id === 'string' && body.id ? body.id : uniquePresetId(current.config, 'preset');
    if (getPreset(current.config, id)) {
      return sendJson(res, 409, { error: `任务集 ${id} 已存在` });
    }
    const preset =
      body.preset && typeof body.preset === 'object'
        ? { ...body.preset, id }
        : blankPreset(id, body.name ?? id);
    const next = upsertPreset(current.config, preset);
    return writeAndRespond(res, store, next, current, { knownNodes, logger });
  }

  if (parsed.kind === 'unknown') return sendJson(res, 404, { error: `未知路由 ${req.method} ${route}` });

  if (parsed.kind === 'preset' || parsed.kind === 'steps' || parsed.kind === 'run') {
    const current = store.read();
    const preset = getPreset(current.config, parsed.id);
    if (!preset) return sendJson(res, 404, { error: `找不到任务集：${parsed.id}` });

    if (parsed.kind === 'run' && req.method === 'POST') {
      if (events.ext.phase !== 'idle') {
        return sendJson(res, 409, { error: `已有任务在${events.ext.phase === 'stopping' ? '停止中' : '运行中'}，请稍候` });
      }
      let body = {};
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      let opts;
      try {
        opts = resolvePresetRun(preset, knownNodes, {
          instance: Number.isInteger(body.instance) ? body.instance : undefined,
          retry: Number.isInteger(body.retry) ? body.retry : undefined,
          runtime: sanitizeRuntimeOverrides(body.runtime).clean,
        });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      events.setPhase('starting');
      sendJson(res, 202, { started: true, options: { ...opts } });
      try {
        await runner.start({ ...opts, onReady: () => events.setPhase('running') });
      } catch (e) {
        logger.error(`任务集 ${parsed.id} 执行失败：${e.message}`);
        events.publishLog({
          ts: new Date().toISOString(),
          level: 'error',
          scope: 'web',
          message: `任务集「${opts.presetName}」执行失败：${e.message}`,
        });
      } finally {
        events.setPhase('idle');
      }
      return undefined;
    }

    if (parsed.kind === 'steps' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      // 两种写法：{ops:[...]} 批量；{order:[...]} / {entry,enabled} 单操作简写
      const ops = Array.isArray(body.ops)
        ? body.ops
        : Array.isArray(body.order)
          ? [{ op: 'reorder', order: body.order }]
          : body.entry
            ? [
                body.enabled !== undefined
                  ? { op: 'toggle', entry: body.entry, enabled: body.enabled }
                  : { op: 'remove', entry: body.entry },
              ]
            : null;
      if (!ops) return sendJson(res, 400, { error: '需要 ops 数组，或 order / entry 简写' });

      const applied = applyStepOps(preset, ops);
      if (!applied.preset) return sendJson(res, 422, { error: '步骤操作未通过校验', errors: applied.errors });
      const next = upsertPreset(current.config, applied.preset);
      return writeAndRespond(res, store, next, current, { knownNodes, logger });
    }

    if (parsed.kind === 'preset') {
      if (req.method === 'PUT') {
        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        const merged = { ...preset, ...body, id: preset.id };
        if (merged.steps !== undefined && !Array.isArray(merged.steps)) {
          return sendJson(res, 422, { error: 'steps 必须是数组（改顺序请用 /steps 接口）' });
        }
        const next = upsertPreset(current.config, merged);
        return writeAndRespond(res, store, next, current, { knownNodes, logger });
      }
      if (req.method === 'DELETE') {
        const next = removePreset(current.config, parsed.id);
        return writeAndRespond(res, store, next, current, { knownNodes, logger });
      }
    }

    return sendJson(res, 405, { error: `${req.method} 不被支持：${route}` });
  }

  return sendJson(res, 404, { error: `未知路由 ${req.method} ${route}` });
}

/** 校验 → 备份 → 原子写 → 让资源缓存失效。 */
function writeAndRespond(res, store, nextConfig, current, { knownNodes, logger }) {
  try {
    const result = store.write(nextConfig, {
      knownNodes,
      expectedMtime: current.mtime,
    });
    logger.info(`任务集已保存：${result.file}${result.backup ? `（备份 ${result.backup}）` : ''}`);
    const warnings = validateTaskConfig(nextConfig, { knownNodes }).warnings;
    return sendJson(res, 200, {
      saved: true,
      file: result.file,
      backup: result.backup,
      warnings,
      presets: nextConfig.presets.map((p) => describePreset(p, knownNodes)),
    });
  } catch (e) {
    const conflict = /已被外部修改/.test(e.message);
    return sendJson(res, conflict ? 409 : 422, { error: e.message });
  }
}

/** 默认的任务集存储（未注入时用）。 */
function defaultTaskStore() {
  return {
    read: () => readTaskConfig(),
    write: (config, options) => writeTaskConfig(config, options),
  };
}

// ---------------------------------------------------------------- 流水线处理器

async function handlePipeline(req, res, route, ctx) {
  const { logger, runner } = ctx;
  const base = decodeURIComponent(route.slice('/api/pipelines/'.length));
  const knownNodes = listPipelineNodes();

  let doc;
  try {
    doc = readPipelineDoc(base);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!doc) return sendJson(res, 404, { error: `找不到流水线：${base}` });

  if (req.method === 'GET') {
    const check = doc.ok
      ? validatePipelineDoc(doc.json, {
          knownNodes,
          customRecognitions: ctx.customRecognitions ?? [],
          customActions: ctx.customActions ?? [],
        })
      : { errors: [{ path: '', message: doc.error }], warnings: [] };
    // 节点详情要加载资源（约 2 秒），失败不影响正文与校验结果
    let details = null;
    try {
      details = await runner.pipelineNodeDetails?.(doc.nodes);
    } catch (e) {
      logger.debug(`取节点详情失败：${e.message}`);
    }
    return sendJson(res, 200, {
      base: doc.base,
      file: doc.file,
      ext: doc.ext,
      text: doc.text,
      mtime: doc.mtime,
      ok: doc.ok,
      nodes: doc.nodes,
      errors: check.errors,
      warnings: check.warnings,
      details,
    });
  }

  if (req.method === 'POST') {
    // 只校验不保存：界面边打字边查
    let body;
    try {
      body = await readBody(req, 2 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    let json;
    if (typeof body.text === 'string') {
      try {
        json = JSON.parse(body.text);
      } catch (e) {
        return sendJson(res, 200, { errors: [{ path: '', message: `不是合法 JSON：${e.message}` }], warnings: [] });
      }
    } else if (body.json && typeof body.json === 'object') {
      json = body.json;
    } else {
      return sendJson(res, 400, { error: '需要 text 或 json 字段' });
    }
    const check = validatePipelineDoc(json, {
      knownNodes,
      customRecognitions: ctx.customRecognitions ?? [],
      customActions: ctx.customActions ?? [],
    });
    return sendJson(res, 200, check);
  }

  if (req.method === 'PUT') {
    let body;
    try {
      body = await readBody(req, 2 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (typeof body.text !== 'string') return sendJson(res, 400, { error: '需要 text 字段（新文件内容）' });
    try {
      const result = writePipelineDoc(doc.base, body.text, {
        knownNodes,
        expectedMtime: Number.isFinite(body.mtime) ? body.mtime : doc.mtime,
        customRecognitions: ctx.customRecognitions ?? [],
        customActions: ctx.customActions ?? [],
      });
      // 流水线变了：下次执行必须重新加载资源
      runner.invalidateResource?.();
      logger.info(`流水线已保存：${result.file}（${result.nodes.length} 个节点，备份 ${result.backup ?? '无'}）`);
      return sendJson(res, 200, {
        saved: true,
        file: result.file,
        backup: result.backup,
        nodes: result.nodes,
        warnings: result.warnings,
      });
    } catch (e) {
      const conflict = /已被外部修改/.test(e.message);
      const invalid = /校验未通过|不是合法 JSON|流水线名非法/.test(e.message);
      return sendJson(res, conflict ? 409 : invalid ? 422 : 500, { error: e.message });
    }
  }

  return sendJson(res, 405, { error: `${req.method} 不被支持：${route}` });
}

// ---------------------------------------------------------------- 配置写入

async function handleConfigWrite(req, res, ctx) {
  const { logger, setConfig, runner } = ctx;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!body.config || typeof body.config !== 'object') {
    return sendJson(res, 400, { error: '需要 config 字段（完整配置对象）' });
  }

  // 路径存在性在这里是警告：保存一份「指向还没装的模拟器」的配置是合法操作，
  // 真正的体检交给 doctor。
  const { errors, warnings } = validateConfig(body.config);
  if (errors.length > 0) {
    return sendJson(res, 422, { error: '配置校验未通过', errors, warnings });
  }

  try {
    const backup = backupFile(PATHS.configFile, PATHS.configBackups);
    writeFileAtomic(PATHS.configFile, `${JSON.stringify(body.config, null, 2)}\n`);
    // 两处都要更新：httphandler 读 configRef，执行层读它自己的 getConfig
    if (ctx.configRef) ctx.configRef.current = body.config;
    setConfig?.(body.config);
    runner?.invalidateResource?.();
    logger.info(`配置已保存：${PATHS.configFile}（备份 ${backup ?? '无'}）`);
    return sendJson(res, 200, { saved: true, file: PATHS.configFile, backup, warnings });
  } catch (e) {
    return sendJson(res, 500, { error: `保存配置失败：${e.message}` });
  }
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
 * 控制台构建产物的默认位置（`npm run webui:build` 生成，已 gitignore）。
 */
export const DEFAULT_WEBUI_DIR = path.join(PATHS.root, 'src', 'webui', 'dist');

/** 决定这次用哪个界面：显式目录 > 自动探测构建产物 > 内联页。 */
function pickWebuiDir(webuiDir) {
  if (webuiDir === false) return null;
  if (typeof webuiDir === 'string' && webuiDir) {
    return fs.existsSync(path.join(webuiDir, 'index.html')) ? webuiDir : null;
  }
  return fs.existsSync(path.join(DEFAULT_WEBUI_DIR, 'index.html')) ? DEFAULT_WEBUI_DIR : null;
}

/**
 * 启动网页服务。
 * @param {object} [options]
 * @param {string|false} [options.webuiDir] 控制台构建产物目录；`false` 强制用内联页，
 *   不传则自动探测 `src/webui/dist`（没有就回落内联页）。
 * @returns {Promise<{url: string, port: number, host: string, webui: string|null, close: () => Promise<void>}>}
 */
export async function startWebServer({
  config,
  logger,
  runner,
  port = 8848,
  host = '127.0.0.1',
  appVersion = '0.0.0',
  token = null,
  setConfig = null,
  scheduler = null,
  customRecognitions = [],
  customActions = [],
  webuiDir = undefined,
}) {
  if (!runner) throw new Error('startWebServer 需要 runner');

  /**
   * 可变配置：PUT /api/config 保存成功后要同时更新内存，
   * 否则 `/api/state`、`/api/tasks` 这些读配置的接口还会用旧的
   * （执行层通过 getConfig 已经拿到新的，两边会不一致）。
   */
  const configRef = { current: config };
  const resolvedWebui = pickWebuiDir(webuiDir);

  const ctx = {
    getConfig: () => configRef.current,
    config,
    configRef,
    logger,
    runner,
    appVersion,
    host,
    token,
    setConfig,
    scheduler,
    customRecognitions,
    customActions,
    webuiDir: resolvedWebui,
  };
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
  if (resolvedWebui) {
    logger?.info(`控制台：Vue 构建产物 ${resolvedWebui}`);
  } else {
    logger?.info('控制台：内联页（要换成 Vue 控制台：npm install && npm run webui:build）');
  }
  if (host !== '127.0.0.1') {
    logger?.warn(`注意：服务监听在 ${host}，局域网内其它机器也能访问（无鉴权）`);
  }

  return {
    url,
    port: actual.port,
    host,
    webui: resolvedWebui,
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
