<script setup>
/**
 * 控制台外壳：顶栏（连接状态 / 版本 / 令牌）+ 左栏（运行控制，常驻）+
 * 右栏（标签页：实时画面 / 任务集 / 流水线 / 日志 / 设备与配置 / 调度 / 产物）+ 提示条。
 *
 * 「运行控制」不放进标签页：它是这个界面唯一的入口动作，
 * 切到别的面板时也应该能一眼看到当前在跑什么、能立刻停。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { store, connect, disconnect, refreshState, dismissToast, toast } from './store.js';
import { getToken, setToken } from './api.js';
import RunPanel from './components/RunPanel.vue';
import LivePanel from './components/LivePanel.vue';
import TasksPanel from './components/TasksPanel.vue';
import PipelinePanel from './components/PipelinePanel.vue';
import LogPanel from './components/LogPanel.vue';
import DevicePanel from './components/DevicePanel.vue';
import SchedulePanel from './components/SchedulePanel.vue';
import ArtifactsPanel from './components/ArtifactsPanel.vue';

const TABS = [
  { id: 'live', label: '实时画面', comp: LivePanel },
  { id: 'tasks', label: '任务集', comp: TasksPanel },
  { id: 'pipelines', label: '流水线', comp: PipelinePanel },
  { id: 'logs', label: '日志', comp: LogPanel },
  { id: 'device', label: '设备与配置', comp: DevicePanel },
  { id: 'schedule', label: '调度', comp: SchedulePanel },
  { id: 'artifacts', label: '产物', comp: ArtifactsPanel },
];

const active = ref('live');
const activeComp = computed(() => TABS.find((t) => t.id === active.value)?.comp ?? LivePanel);

const tokenInput = ref('');
const showToken = ref(false);

const connText = computed(() => {
  if (store.connection === 'open') return '已连接';
  if (store.connection === 'connecting') return '连接中…';
  return '已断开';
});
const connClass = computed(() => {
  if (store.connection === 'open') return 'dot on';
  if (store.connection === 'connecting') return 'dot warn';
  return 'dot err';
});

const run = computed(() => store.state?.run ?? {});
const app = computed(() => store.state?.app ?? {});
const config = computed(() => store.state?.config ?? {});
const presetCount = computed(() => store.state?.presets?.length ?? 0);
const moduleCount = computed(() => store.state?.modules?.length ?? 0);

function saveToken() {
  setToken(tokenInput.value.trim());
  showToken.value = false;
  toast(tokenInput.value.trim() ? '令牌已保存到本机' : '令牌已清除', 'ok');
}

let stateTimer = null;

onMounted(async () => {
  tokenInput.value = getToken();
  connect();
  try {
    await refreshState();
  } catch {
    // 连不上时 SSE 会自己重试，这里只提示一次，别刷屏
    toast('读不到状态快照，服务可能还没起来', 'warn');
  }
  // SSE 已经推送状态变化，这个定时器只是兜底（例如页面被浏览器冻结后恢复）
  stateTimer = setInterval(() => {
    refreshState().catch(() => {});
  }, 30000);
});

onUnmounted(() => {
  if (stateTimer) clearInterval(stateTimer);
  disconnect();
});
</script>

<template>
  <div class="app">
    <header class="app-header">
      <span :class="run.running ? 'dot on' : connClass" />
      <h1>无尽冬日 · 日常自动化</h1>
      <span class="dim">v{{ app.version ?? '—' }}</span>
      <span class="dim">{{ config.package ?? '—' }}</span>
      <span class="dim">短边 {{ config.shortSide ?? '—' }}</span>
      <span class="spacer" />
      <span class="dim">{{ connText }}</span>
      <button class="mini ghost" title="服务以 --allow-remote 启动时，写操作需要 X-Token" @click="showToken = !showToken">
        令牌
      </button>
    </header>

    <div v-if="showToken" class="app-header" style="gap: 8px">
      <span class="dim">X-Token</span>
      <input
        v-model="tokenInput"
        class="grow"
        style="max-width: 420px"
        placeholder="--allow-remote 启动时终端会打印这个令牌"
        @keyup.enter="saveToken"
      >
      <button class="primary" @click="saveToken">保存</button>
      <button @click="showToken = false">取消</button>
    </div>

    <div class="app-body">
      <div class="col">
        <RunPanel />
      </div>
      <div class="col">
        <div class="tabs">
          <button
            v-for="t in TABS"
            :key="t.id"
            :class="{ active: active === t.id }"
            @click="active = t.id"
          >
            {{ t.label }}
            <span v-if="t.id === 'tasks' && presetCount" class="dim">({{ presetCount }})</span>
          </button>
        </div>
        <component :is="activeComp" />
      </div>
    </div>

    <footer class="app-footer">
      <span>{{ store.lastAction || '就绪' }}</span>
      <span class="spacer" style="flex: 1" />
      <span>模块 {{ moduleCount }} · 任务集 {{ presetCount }} · 日志 {{ store.logs.length }}</span>
    </footer>

    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.level">
        <div style="display: flex; gap: 8px; align-items: flex-start">
          <div style="flex: 1">{{ t.message }}</div>
          <button class="mini ghost" @click="dismissToast(t.id)">✕</button>
        </div>
        <div v-if="t.detail" class="detail">{{ t.detail }}</div>
      </div>
    </div>
  </div>
</template>
