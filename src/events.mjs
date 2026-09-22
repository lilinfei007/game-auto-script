/**
 * 进程内事件总线：把日志、节点事件、任务状态集中发布，供 Web UI（SSE）订阅。
 *
 * 刻意不依赖任何其它模块（只用 node:events），避免与 util/log.mjs 形成循环依赖。
 * 同时保留一小段历史，新连上的客户端可以立刻看到上下文，而不是干等下一行日志。
 */
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const LOG_LIMIT = 800;
const NODE_LIMIT = 300;

const logHistory = [];
const nodeHistory = [];

/** 当前运行状态快照。 */
export const state = {
  running: false,
  entries: [],
  current: null,
  startedAt: null,
  finishedAt: null,
  results: [],
};

export function publishLog(entry) {
  logHistory.push(entry);
  if (logHistory.length > LOG_LIMIT) logHistory.shift();
  bus.emit('log', entry);
}

export function publishNode(entry) {
  nodeHistory.push(entry);
  if (nodeHistory.length > NODE_LIMIT) nodeHistory.shift();
  bus.emit('node', entry);
}

export function publishTask(entry) {
  bus.emit('task', entry);
}

export function publishState() {
  bus.emit('state', { ...state });
}

export function getLogHistory() {
  return logHistory.slice();
}

export function getNodeHistory() {
  return nodeHistory.slice();
}

export function beginRun(entries) {
  state.running = true;
  state.entries = [...entries];
  state.current = null;
  state.startedAt = Date.now();
  state.finishedAt = null;
  state.results = [];
  publishState();
}

export function setCurrent(entry) {
  state.current = entry;
  publishState();
}

export function addResult(result) {
  state.results.push(result);
  publishState();
}

export function endRun() {
  state.running = false;
  state.current = null;
  state.finishedAt = Date.now();
  publishState();
}

/** 供测试重置。 */
export function resetForTest() {
  logHistory.length = 0;
  nodeHistory.length = 0;
  Object.assign(state, {
    running: false,
    entries: [],
    current: null,
    startedAt: null,
    finishedAt: null,
    results: [],
  });
}
