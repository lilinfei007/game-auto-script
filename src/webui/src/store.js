/**
 * 全局状态：SSE 长连接 + 后端快照 + 日志缓冲 + 提示条。
 *
 * 为什么不用 Pinia：这里只有一个 store、没有跨模块依赖，`reactive()` 足够；
 * 少一个依赖，控制台就少一处需要跟着 Vue 版本升级的东西。
 *
 * 状态分两层：
 *  - 「快照层」（state）：由 `/api/state` 与 SSE 的 `snapshot`/`state` 事件维护，
 *    页面只读它，不自己拼运行状态（避免界面和后端漂移）。
 *  - 「详情层」（tasks/pipelines/config/...）：各面板自己按需拉取并持有，
 *    因为它们是「打开哪个才读哪个」的大对象，放全局只会互相拖慢。
 */
import { reactive } from 'vue';
import { api, errorText, ApiError } from './api.js';

const LOG_LIMIT = 3000;
const NODE_LIMIT = 500;

export const store = reactive({
  /** 与服务端的连接状态：connecting / open / closed */
  connection: 'connecting',
  /** `/api/state` 的全量快照 */
  state: null,
  /** 状态是否至少加载过一次 */
  loaded: false,
  /** 日志（SSE log 事件，连上时后端会补发最近 800 条） */
  logs: [],
  /** 流水线节点事件（SSE node 事件） */
  nodes: [],
  /** Tasker 任务级回调（SSE task 事件） */
  taskEvents: [],
  /** 提示条 */
  toasts: [],
  /** 最近一次动作的状态文案（给底部状态栏用） */
  lastAction: '',
});

let toastSeq = 0;
let es = null;

/** 弹一条提示；`level` 取 info / ok / warn / error。 */
export function toast(message, level = 'info', detail = '') {
  const id = ++toastSeq;
  store.toasts.push({ id, message, level, detail, at: Date.now() });
  const ttl = level === 'error' ? 9000 : level === 'warn' ? 6000 : 3500;
  setTimeout(() => dismissToast(id), ttl);
  return id;
}

export function dismissToast(id) {
  const i = store.toasts.findIndex((t) => t.id === id);
  if (i >= 0) store.toasts.splice(i, 1);
}

/**
 * 包一层异步动作：统一 loading 文案、统一错误提示、统一把 401 讲清楚。
 * 返回 `{ok, data}` 或 `{ok:false, error}`，调用方不必写 try/catch。
 */
export async function guard(label, fn) {
  store.lastAction = `${label}…`;
  try {
    const data = await fn();
    store.lastAction = `${label} ✓`;
    return { ok: true, data };
  } catch (e) {
    const detail = e instanceof ApiError ? e.payload?.errors : null;
    const extra = Array.isArray(detail)
      ? detail.map((d) => (d?.path ? `${d.path}：${d.message}` : d?.message)).filter(Boolean).join('；')
      : '';
    if (e instanceof ApiError && e.status === 401) {
      toast('需要令牌：服务以 --allow-remote 启动，请在右上角填 X-Token', 'warn');
    } else if (e instanceof ApiError && e.status === 409) {
      toast(`${label}失败：${errorText(e)}`, 'warn', extra);
    } else {
      toast(`${label}失败：${errorText(e)}`, 'error', extra);
    }
    store.lastAction = `${label} ✗`;
    return { ok: false, error: e };
  }
}

function pushCapped(list, item, limit) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  store.state = snapshot;
  store.loaded = true;
}

/** 拉一次全量快照（SSE 还没连上或断线重连后用它兜底）。 */
export async function refreshState() {
  const s = await api.state();
  applySnapshot(s);
  return s;
}

/** 建立 SSE 长连接；断线由 EventSource 自己重连，这里只维护状态显示。 */
export function connect() {
  if (es) return es;
  store.connection = 'connecting';
  es = new EventSource('/api/events');

  es.addEventListener('open', () => {
    store.connection = 'open';
  });
  es.addEventListener('snapshot', (e) => {
    store.connection = 'open';
    applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener('state', (e) => {
    const run = JSON.parse(e.data);
    if (store.state) store.state.run = run;
    else store.state = { run };
  });
  es.addEventListener('log', (e) => pushCapped(store.logs, JSON.parse(e.data), LOG_LIMIT));
  es.addEventListener('node', (e) => pushCapped(store.nodes, JSON.parse(e.data), NODE_LIMIT));
  es.addEventListener('task', (e) => pushCapped(store.taskEvents, JSON.parse(e.data), NODE_LIMIT));
  es.addEventListener('device', (e) => {
    const device = JSON.parse(e.data);
    if (store.state) store.state.device = device;
  });
  es.addEventListener('schedule', (e) => {
    const schedule = JSON.parse(e.data);
    if (store.state) store.state.schedule = schedule;
  });
  es.addEventListener('run', () => {
    // 运行记录变了：重拉快照最省事（runs[] 由后端裁剪成最近 20 条）
    refreshState().catch(() => {});
  });
  es.addEventListener('error', () => {
    store.connection = es && es.readyState === EventSource.CLOSED ? 'closed' : 'connecting';
  });
  return es;
}

export function disconnect() {
  es?.close();
  es = null;
  store.connection = 'closed';
}

// ---------------------------------------------------------------- 派生视图

export function runState() {
  return (
    store.state?.run ?? {
      running: false,
      phase: 'idle',
      entries: [],
      current: null,
      results: [],
      status: 'idle',
    }
  );
}

/** 界面里所有「现在能不能操作设备」的判断都走这里，与后端 409 的语义一致。 */
export function isBusy() {
  const run = runState();
  return run.running || (run.phase && run.phase !== 'idle');
}
