/**
 * 接口层：控制台与后端之间的唯一出口。
 *
 * 三件事集中在这里做，页面里不再重复：
 *  1. JSON 编解码与统一错误对象（`ApiError` 带 HTTP 状态码，页面按码分支）；
 *  2. `X-Token`（后端用 `--allow-remote` 启动时写操作需要）从本地存储带上；
 *  3. 网络层异常（服务被 Ctrl+C 关掉）转成同一种错误，不让页面各处 catch fetch。
 */

const TOKEN_KEY = 'wjdr.console.token';

export class ApiError extends Error {
  /**
   * @param {string} message 面向人的错误说明
   * @param {number} status HTTP 状态码（0 表示没连上）
   * @param {any} payload 后端返回的原始 JSON（可能有 errors[] 逐条错误）
   */
  constructor(message, status, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下 localStorage 会抛，忽略即可 */
  }
}

async function request(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers['x-token'] = token;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(`连不上服务（${e.message}）—— 服务还在跑吗？`, 0, null);
  }

  const type = res.headers.get('content-type') ?? '';
  let payload = null;
  if (type.includes('application/json')) {
    payload = await res.json().catch(() => null);
  } else if (type.startsWith('text/')) {
    payload = await res.text().catch(() => null);
  }

  if (!res.ok) {
    const message =
      (payload && typeof payload === 'object' && payload.error) ||
      (typeof payload === 'string' && payload.trim()) ||
      `HTTP ${res.status}`;
    throw new ApiError(message, res.status, payload);
  }
  return payload;
}

const q = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  // ---- 状态与运行 ----
  state: () => request('GET', '/api/state'),
  run: (body) => request('POST', '/api/run', body ?? {}),
  stop: () => request('POST', '/api/stop', {}),
  runNode: (body) => request('POST', '/api/nodes/run', body),

  // ---- 产物 ----
  artifacts: () => request('GET', '/api/artifacts'),
  shotUrl: (rel) => `/api/shot?path=${encodeURIComponent(rel)}`,

  // ---- 实时画面与手动操作 ----
  liveShotUrl: (instance) => `/api/live/shot${q({ instance })}&_=${Date.now()}`,
  liveStart: (body) => request('POST', '/api/live/start', body ?? {}),
  liveStop: () => request('POST', '/api/live/stop', {}),
  tap: (body) => request('POST', '/api/input/tap', body),
  swipe: (body) => request('POST', '/api/input/swipe', body),

  // ---- 设备 ----
  device: () => request('GET', '/api/device'),
  launchDevice: (index) => request('POST', '/api/device/launch', { index }),

  // ---- 配置与自检 ----
  config: () => request('GET', '/api/config'),
  saveConfig: (config) => request('PUT', '/api/config', { config }),
  doctor: () => request('POST', '/api/doctor', {}),

  // ---- 任务集 ----
  tasks: () => request('GET', '/api/tasks'),
  createPreset: (body) => request('POST', '/api/tasks/presets', body ?? {}),
  updatePreset: (id, patch) => request('PUT', `/api/tasks/presets/${encodeURIComponent(id)}`, patch),
  deletePreset: (id) => request('DELETE', `/api/tasks/presets/${encodeURIComponent(id)}`),
  stepOps: (id, ops) => request('POST', `/api/tasks/presets/${encodeURIComponent(id)}/steps`, { ops }),
  runPreset: (id, body) => request('POST', `/api/tasks/presets/${encodeURIComponent(id)}/run`, body ?? {}),

  // ---- 流水线 ----
  pipelines: () => request('GET', '/api/pipelines'),
  pipeline: (base) => request('GET', `/api/pipelines/${encodeURIComponent(base)}`),
  validatePipeline: (base, text) => request('POST', `/api/pipelines/${encodeURIComponent(base)}`, { text }),
  savePipeline: (base, text, mtime) =>
    request('PUT', `/api/pipelines/${encodeURIComponent(base)}`, { text, mtime }),

  // ---- 调度 ----
  schedule: () => request('GET', '/api/schedule'),
  checkSchedule: () => request('POST', '/api/schedule/check', {}),
};

/** 把任意异常转成一句能显示给用户的话。 */
export function errorText(e) {
  if (e instanceof ApiError) return e.message;
  return e?.message ?? String(e);
}
