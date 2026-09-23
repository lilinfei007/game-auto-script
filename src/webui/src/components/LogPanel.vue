<script setup>
/**
 * 日志面板：SSE 的三路事件流分开看。
 *
 *  - `log`：每一行日志（连上时后端补发最近 800 条，所以打开页面不会空白）
 *  - `node`：流水线节点开始/失败（排查「卡在哪个节点」用这个，比翻日志快）
 *  - `task`：Tasker 的任务级回调
 *
 * 过滤在本地做：日志量是每秒几条，前端过滤比给后端加查询参数简单得多。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { store } from '../store.js';

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
const minLevel = ref('info');
const scopeFilter = ref('');
const keyword = ref('');
const autoScroll = ref(true);
const view = ref('log');

const box = ref(null);

const levelRank = (l) => {
  const i = LEVELS.indexOf(l ?? 'info');
  return i < 0 ? 2 : i;
};

const scopes = computed(() => {
  const set = new Set();
  for (const l of store.logs) if (l.scope) set.add(l.scope);
  return [...set].sort();
});

const visibleLogs = computed(() => {
  const limit = levelRank(minLevel.value);
  const scope = scopeFilter.value;
  const kw = keyword.value.trim().toLowerCase();
  return store.logs.filter((l) => {
    if (levelRank(l.level) > limit) return false;
    if (scope && l.scope !== scope) return false;
    if (kw && !`${l.message ?? ''}`.toLowerCase().includes(kw)) return false;
    return true;
  });
});

const visibleNodes = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return store.nodes.filter((n) => !kw || `${n.name ?? ''}`.toLowerCase().includes(kw));
});

watch(
  () => [visibleLogs.value.length, view.value],
  async () => {
    if (!autoScroll.value || view.value !== 'log') return;
    await nextTick();
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  },
);

function clearLocal() {
  store.logs.splice(0, store.logs.length);
  store.nodes.splice(0, store.nodes.length);
  store.taskEvents.splice(0, store.taskEvents.length);
}

async function copyAll() {
  const text = visibleLogs.value
    .map((l) => `[${(l.level ?? '').toUpperCase()}] [${l.scope}] ${l.message}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    store.lastAction = `已复制 ${visibleLogs.value.length} 行日志`;
  } catch {
    store.lastAction = '复制失败（浏览器拒绝了剪贴板权限）';
  }
}

const shortTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
};
</script>

<template>
  <section class="panel">
    <h2>
      日志
      <span class="spacer" />
      <button class="mini" :class="{ primary: view === 'log' }" @click="view = 'log'">日志 {{ store.logs.length }}</button>
      <button class="mini" :class="{ primary: view === 'node' }" @click="view = 'node'">节点 {{ store.nodes.length }}</button>
      <button class="mini" :class="{ primary: view === 'task' }" @click="view = 'task'">任务 {{ store.taskEvents.length }}</button>
    </h2>

    <div class="row tight" style="margin-top: 0; flex-wrap: wrap">
      <select v-model="minLevel" style="max-width: 130px">
        <option v-for="l in LEVELS" :key="l" :value="l">≥ {{ l }}</option>
      </select>
      <select v-model="scopeFilter" style="max-width: 160px">
        <option value="">全部来源</option>
        <option v-for="s in scopes" :key="s" :value="s">{{ s }}</option>
      </select>
      <input v-model="keyword" class="grow" placeholder="关键字过滤…">
      <label class="dim" style="display: flex; gap: 5px; align-items: center; white-space: nowrap">
        <input v-model="autoScroll" type="checkbox" style="width: auto">自动滚到底
      </label>
      <button class="mini" @click="copyAll">复制</button>
      <button class="mini" @click="clearLocal">清空本地</button>
    </div>

    <div v-if="view === 'log'" ref="box" class="log-box" style="margin-top: 8px">
      <div v-if="!visibleLogs.length" class="empty">没有匹配的日志</div>
      <div v-for="(l, i) in visibleLogs" :key="i" class="log-line">
        <span class="ts">{{ shortTime(l.ts) }}</span>
        <span :class="'l-' + (l.level || 'info')">
          [{{ (l.level || '').toUpperCase() }}] [{{ l.scope }}] {{ l.message }}
        </span>
      </div>
    </div>

    <div v-else-if="view === 'node'" class="log-box" style="margin-top: 8px">
      <div v-if="!visibleNodes.length" class="empty">还没有节点事件（跑一次任务就有了）</div>
      <div v-for="(n, i) in visibleNodes" :key="i" class="log-line">
        <span class="ts">{{ shortTime(n.ts) }}</span>
        <span :class="n.phase === 'failed' ? 'l-error' : 'l-info'">
          [{{ n.kind }}] {{ n.phase }} · {{ n.name }}
        </span>
      </div>
    </div>

    <div v-else class="log-box" style="margin-top: 8px">
      <div v-if="!store.taskEvents.length" class="empty">还没有任务级回调</div>
      <div v-for="(t, i) in store.taskEvents" :key="i" class="log-line">
        <span class="ts">{{ shortTime(t.ts) }}</span>
        <span class="l-info">[{{ t.phase }}] {{ t.entry }} {{ t.uuid ? '· ' + t.uuid : '' }}</span>
      </div>
    </div>

    <p class="dim" style="margin-top: 8px">
      本地缓冲上限：日志 {{ store.logs.length }}/3000 行、节点 {{ store.nodes.length }}/500 条。
      「清空本地」只影响这个页面，磁盘上的 debug/ 日志不受影响。
    </p>
  </section>
</template>
