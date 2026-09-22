/**
 * 进程内事件总线：把日志、节点事件、任务与运行状态集中发布，供 Web UI（SSE）订阅。
 *
 * 刻意不依赖任何其它模块（只用 node:events 与 node:crypto），避免与 util/log.mjs
 * 形成循环依赖。同时保留一小段历史，新连上的客户端可以立刻看到上下文。
 *
 * 兼容性约定（**不要随意改**）：
 *   `beginRun / setCurrent / addResult / endRun` 与 `state.running / state.current /
 *   state.startedAt / state.finishedAt / state.results` 是既有 Web UI 与测试依赖的
 *   最小契约。run 记录是后加的**上层结构**，上述字段由 run 记录派生，语义保持：
 *     - `beginRun(entries)` 后 `state.running === true`
 *     - `endRun()` 后 `state.running === false`
 *   另外 `beginRun` 必须发布一次 state 事件（老实现如此，测试依赖这一行为）。
 */
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const LOG_LIMIT = 800;
const NODE_LIMIT = 300;
/** 最多保留多少次运行记录（含进行中的那次）。 */
const RUN_LIMIT = 20;
/** 单次运行内保留的节点事件条数。 */
const RUN_NODE_LIMIT = 400;

/** 运行阶段：idle → starting → running → stopping → idle。 */
export const PHASES = ['idle', 'starting', 'running', 'stopping'];

const logHistory = [];
const nodeHistory = [];
/** @type {object[]} 运行记录，最新的在最前。 */
const runs = [];

/** 当前运行状态快照（对外的兼容视图）。 */
export const state = {
  running: false,
  entries: [],
  current: null,
  startedAt: null,
  finishedAt: null,
  results: [],
};

/** 扩展状态：阶段、设备、调度、最近运行。 */
export const ext = {
  phase: 'idle',
  device: null,
  schedule: { enabled: false, jobs: [], history: [] },
};

let activeRun = null;

const nowIso = () => new Date().toISOString();

/**
 * 派生兼容视图：只从**活跃** run 生成 state 的字段。
 *
 * ⚠️ 这里刻意不回退到 `runs[0]`：run 结束（activeRun 置空）之后再回退读取那条
 * 已完成的记录，会把 `startedAt`/`finishedAt` 反向覆盖 —— 已完成记录的
 * `finishedAt` 在 `state` 上会被写成 null，表现为「跑完了但 finishedAt 是 0」。
 * 结束时的收尾字段由 `finishRun()` 自己写。
 */
function syncFromRun() {
  const r = activeRun;
  state.running = !!r && r.status === 'running';
  state.entries = r ? [...r.entries] : [];
  state.current = r ? r.current : null;
  state.startedAt = r ? r.startedAt : null;
  state.finishedAt = r && r.finishedAt ? r.finishedAt : null;
  state.results = r ? r.results.map((x) => ({ ...x })) : [];
}

/** 生成一条运行记录（不进入 runs，先交给调用方补字段）。 */
function blankRun(entries, opts = {}) {
  return {
    id: `run-${crypto.randomUUID().slice(0, 8)}`,
    presetId: opts.preset ?? null,
    presetName: opts.presetName ?? null,
    trigger: opts.trigger ?? 'manual',
    instance: Number.isInteger(opts.instance) ? opts.instance : null,
    entries: [...entries],
    phase: 'running',
    status: 'running',
    current: null,
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    nodes: [],
  };
}

/** 只在确实有变化时发布：SSE 下频繁的 null 更新纯属噪音。 */
function deviceEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.index === b.index &&
    a.ready === b.ready &&
    a.address === b.address &&
    a.live === b.live &&
    a.detail === b.detail
  );
}

export function publishLog(entry) {
  logHistory.push(entry);
  if (logHistory.length > LOG_LIMIT) logHistory.shift();
  bus.emit('log', entry);
}

export function publishNode(entry) {
  nodeHistory.push(entry);
  if (nodeHistory.length > NODE_LIMIT) nodeHistory.shift();
  if (activeRun) {
    activeRun.nodes.push({ ...entry, ts: Date.now() });
    if (activeRun.nodes.length > RUN_NODE_LIMIT) activeRun.nodes.shift();
  }
  bus.emit('node', entry);
}

export function publishTask(entry) {
  bus.emit('task', entry);
}

/** 设置运行阶段并广播。 */
export function setPhase(phase) {
  if (!PHASES.includes(phase)) throw new Error(`未知运行阶段：${phase}`);
  ext.phase = phase;
  if (activeRun) activeRun.phase = phase;
  publishState();
}

/** 更新设备状态（同值不重复广播）。 */
export function publishDevice(device) {
  if (deviceEquals(ext.device, device)) return;
  ext.device = device;
  bus.emit('device', device);
}

/** 更新调度状态（作业列表 + 最近历史）。 */
export function publishSchedule(schedule) {
  ext.schedule = schedule;
  bus.emit('schedule', schedule);
}

/**
 * 记录一次调度事件（触发 / 跳过 / 报错），供界面显示历史。
 *
 * 只动 history 这一项：早先整体替换 `ext.schedule`，把 jobs / enabled 一起冲掉了，
 * 于是「调度明明在跑，界面上却没启用、作业列表也是空的」。
 */
export function publishScheduleEvent(event) {
  const prev = ext.schedule ?? {};
  ext.schedule = {
    ...prev,
    history: [{ ts: Date.now(), ...event }, ...(prev.history ?? [])].slice(0, 50),
  };
  bus.emit('schedule', ext.schedule);
}

/** 广播当前状态。 */
export function publishState() {
  bus.emit('state', buildRunState());
}

/**
 * 当前运行的对外快照。
 *
 * `run`：当前（或最近一次）运行的完整记录；无运行记录时为 null。
 * `entries/current/startedAt/finishedAt/results`：**顶层兼容字段**，
 * 老界面直接读这些，不要删。
 */
export function buildRunState() {
  const r = activeRun ?? runs[0] ?? null;
  return {
    running: state.running,
    phase: ext.phase,
    entries: [...state.entries],
    current: state.current,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    results: state.results.map((x) => ({ ...x })),
    runId: r ? r.id : null,
    presetId: r ? r.presetId : null,
    presetName: r ? r.presetName : null,
    trigger: r ? r.trigger : null,
    status: r ? r.status : 'idle',
    error: r ? (r.error ?? null) : null,
  };
}

/** 最近若干次运行记录（副本，避免调用方改到内部状态）。 */
export function getRuns(limit = 20) {
  return runs.slice(0, Math.max(0, limit)).map((r) => ({
    ...r,
    entries: [...r.entries],
    results: r.results.map((x) => ({ ...x })),
    nodes: r.nodes.slice(-60),
  }));
}

export function getLogHistory() {
  return logHistory.slice();
}

export function getNodeHistory() {
  return nodeHistory.slice();
}

/** 是否真有任务在跑（不看 starting/stopping 这些准备阶段）。 */
export function isRunning() {
  return state.running;
}

export function getActiveRun() {
  return activeRun;
}

/**
 * 开始一次运行。
 *
 * @param {string[]} entries 要执行的入口（顺序即为执行顺序）
 * @param {object} [opts] `{ preset, presetName, trigger, instance }`
 */
export function startRun(entries, opts = {}) {
  if (activeRun && activeRun.status === 'running') {
    throw new Error('已有任务在运行中');
  }
  activeRun = blankRun(entries, opts);
  runs.unshift(activeRun);
  if (runs.length > RUN_LIMIT) runs.length = RUN_LIMIT;
  ext.phase = 'running';
  syncFromRun();
  /**
   * 发布「运行开始」事件。
   *
   * 排查「一次执行变成两条记录」这类问题时，必须能看出每次 startRun 的
   * 来源（trigger / preset）。这里只发事件、不直接写日志 —— 本模块刻意不依赖
   * util/log.mjs（避免循环依赖），由 CLI 层订阅后按日志等级记录。
   */
  bus.emit('run/start', {
    id: activeRun.id,
    trigger: activeRun.trigger,
    preset: activeRun.presetId,
    entries: [...activeRun.entries],
    at: activeRun.startedAt,
  });
  bus.emit('run', { ...buildRunState() });
  publishState();
  return activeRun;
}

/** 结束当前运行：`status` 取 `'ok' | 'failed' | 'stopped'`。 */
export function finishRun(status = 'ok', error = null) {
  const r = activeRun ?? runs[0];
  if (!r) return null;
  r.status = status;
  r.error = error;
  r.finishedAt = Date.now();
  r.current = null;
  ext.phase = 'idle';
  activeRun = null;
  syncFromRun();
  // syncFromRun 清空了可变字段，这里补上「刚结束」的收尾信息
  state.entries = [...r.entries];
  state.results = r.results.map((x) => ({ ...x }));
  state.startedAt = r.startedAt;
  state.finishedAt = r.finishedAt;
  bus.emit('run', { ...buildRunState() });
  publishState();
  return r;
}

// ---------------------------------------------------------------- 兼容层
// 老 API：供 runner.mjs / web.mjs / 既有测试使用。内部改为写 run 记录。

/** @deprecated 用 startRun 可以带更多信息；此处保留兼容语义。 */
export function beginRun(entries, opts = {}) {
  if (activeRun && activeRun.status === 'running') {
    // 老语义是直接覆盖，但不能丢掉「上一个 run」的记录：先收尾再开新的
    finishRun('stopped');
  }
  return startRun(entries, opts);
}

export function setCurrent(entry) {
  state.current = entry;
  if (activeRun) activeRun.current = entry;
  publishState();
}

export function addResult(result) {
  state.results.push(result);
  if (activeRun) activeRun.results.push({ ...result });
  publishState();
}

export function endRun() {
  // 与 beginRun 对称：没有活跃 run 时不要凭空造记录，但要发布一次收尾状态
  if (activeRun) {
    const failed = activeRun.results.some((x) => !x.ok);
    finishRun(failed ? 'failed' : 'ok');
    return;
  }
  // 没有活跃 run：补一个 finishedAt 再广播，让调用方知道「已经跑完了」
  state.finishedAt = state.finishedAt ?? Date.now();
  publishState();
}

/** 供测试重置。 */
export function resetForTest() {
  logHistory.length = 0;
  nodeHistory.length = 0;
  runs.length = 0;
  activeRun = null;
  Object.assign(state, {
    running: false,
    entries: [],
    current: null,
    startedAt: null,
    finishedAt: null,
    results: [],
  });
  ext.phase = 'idle';
  ext.device = null;
  ext.schedule = { enabled: false, jobs: [], history: [] };
}
