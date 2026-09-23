<script setup>
/**
 * 运行控制：两条启动路径（任务集 / 临时勾选模块）+ 停止 + 进度 + 最近运行记录。
 *
 * 两条路径的区别只在「谁来定顺序」：
 *  - 任务集：顺序、开关、单步超时都写在 config/tasks.json 里，可定时复用；
 *  - 临时勾选：只跑这一次，顺序按模块文件名（与 CLI 的自动发现一致）。
 */
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';
import { store, guard, isBusy, runState, toast } from '../store.js';

const instance = ref(0);
const retry = ref(0);
const presetId = ref('');
const picked = ref([]);

const config = computed(() => store.state?.config ?? {});
const instances = computed(() => config.value.instances ?? []);
const modules = computed(() => store.state?.modules ?? []);
const presets = computed(() => store.state?.presets ?? []);
const run = computed(() => runState());
const busy = computed(() => isBusy());
const stopping = computed(() => run.value.phase === 'stopping');

const phaseText = computed(() => {
  if (!run.value.running) return run.value.finishedAt ? '已结束' : '空闲';
  if (run.value.phase === 'starting') return '正在准备（连模拟器、加载资源）';
  if (run.value.phase === 'stopping') return '正在停止';
  return '运行中';
});

const runnablePresets = computed(() => presets.value.filter((p) => p.runnable !== false));
const selectedPreset = computed(() => presets.value.find((p) => p.id === presetId.value) ?? null);

// 实例：配置变了或首次拿到快照时，落到第一个可用实例
watch(
  instances,
  (list) => {
    if (!list.length) return;
    if (!list.some((i) => i.index === instance.value)) instance.value = list[0].index;
  },
  { immediate: true },
);
// 任务集：默认选中第一个可跑的
watch(
  runnablePresets,
  (list) => {
    if (!list.length) {
      presetId.value = '';
      return;
    }
    if (!list.some((p) => p.id === presetId.value)) presetId.value = list[0].id;
  },
  { immediate: true },
);

async function startPreset() {
  const preset = selectedPreset.value;
  if (!preset) return;
  const r = await guard(`执行任务集「${preset.name}」`, () =>
    api.runPreset(preset.id, { instance: instance.value, retry: retry.value }),
  );
  if (r.ok) toast(`已开始：${preset.name}（${preset.enabledCount} 个步骤）`, 'ok');
}

async function startModules() {
  const tasks = picked.value.slice();
  if (tasks.length === 0) {
    toast('没勾选模块：后端会退回「按文件名跑全部模块」', 'warn');
  }
  const r = await guard('执行所选模块', () =>
    api.run({ tasks: tasks.length ? tasks : undefined, instance: instance.value, retry: retry.value }),
  );
  if (r.ok) toast('已提交执行，进度见下方', 'ok');
}

async function stop() {
  await guard('停止当前任务', () => api.stop());
}

function togglePick(entry) {
  const i = picked.value.indexOf(entry);
  if (i >= 0) picked.value.splice(i, 1);
  else picked.value.push(entry);
}

function pickAll() {
  picked.value = modules.value.filter((m) => m.ok && m.entry).map((m) => m.entry);
}

function pickNone() {
  picked.value = [];
}

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '—');

function elapsed(r) {
  if (!r.startedAt) return '';
  const end = r.finishedAt ?? Date.now();
  return `${((end - r.startedAt) / 1000).toFixed(1)}s`;
}

const statusBadge = (status) => {
  if (status === 'ok') return 'badge ok';
  if (status === 'failed') return 'badge err';
  if (status === 'stopped') return 'badge warn';
  if (status === 'running') return 'badge info';
  return 'badge';
};
</script>

<template>
  <section class="panel">
    <h2>运行控制</h2>

    <label class="field">实例</label>
    <select v-model.number="instance" :disabled="busy">
      <option v-for="i in instances" :key="i.index" :value="i.index" :disabled="!i.enabled">
        [{{ i.index }}] {{ i.address }}{{ i.enabled ? '' : '（已禁用）' }}
      </option>
      <option v-if="!instances.length" :value="0">（配置里没有实例）</option>
    </select>

    <label class="field">失败重试次数（重试前先回主界面）</label>
    <input v-model.number="retry" type="number" min="0" max="5" :disabled="busy">

    <template v-if="runnablePresets.length">
      <label class="field">任务集</label>
      <select v-model="presetId" :disabled="busy">
        <option v-for="p in runnablePresets" :key="p.id" :value="p.id">
          {{ p.name }}（{{ p.enabledCount }} 步）{{ p.schedule?.enabled ? ' · 定时' : '' }}
        </option>
      </select>
      <div class="row">
        <button class="primary grow" :disabled="busy || !selectedPreset" @click="startPreset">
          执行任务集
        </button>
        <button :disabled="!busy || stopping" @click="stop">停止</button>
      </div>
      <p class="panel-sub" style="margin-top: 8px">
        顺序与开关来自 <span class="mono-sm">config/tasks.json</span>，在「任务集」页编辑。
      </p>
    </template>

    <template v-else>
      <p class="notice" style="margin-top: 10px">
        还没有任务集。可以临时勾选模块直接跑，或到「任务集」页建一个（可定时、可复用）。
      </p>
    </template>

    <details style="margin-top: 10px">
      <summary class="dim" style="cursor: pointer">临时勾选模块执行（不写任务集）</summary>
      <div class="row tight">
        <button class="mini ghost" :disabled="busy" @click="pickAll">全选</button>
        <button class="mini ghost" :disabled="busy" @click="pickNone">清空</button>
        <span class="dim">已选 {{ picked.length }}</span>
      </div>
      <div style="max-height: 200px; overflow: auto; border: 1px solid var(--line); border-radius: 5px; padding: 6px; margin-top: 6px">
        <div v-if="!modules.length" class="empty">没有发现任何模块</div>
        <label
          v-for="m in modules"
          :key="m.base"
          style="display: flex; gap: 7px; align-items: center; margin: 2px 0; cursor: pointer"
          :style="{ opacity: m.ok ? 1 : 0.6 }"
        >
          <input
            type="checkbox"
            style="width: auto"
            :value="m.entry"
            :disabled="busy || !m.ok"
            :checked="picked.includes(m.entry)"
            @change="togglePick(m.entry)"
          >
          <span :class="{ dim: !m.ok }">{{ m.base }} → {{ m.entry || '（无入口）' }}</span>
          <span v-if="!m.ok" class="badge err">{{ m.error }}</span>
        </label>
      </div>
      <div class="row">
        <button class="grow" :disabled="busy" @click="startModules">执行所选模块</button>
      </div>
    </details>
  </section>

  <section class="panel" style="margin-top: 12px">
    <h2>
      进度
      <span class="spacer" />
      <span v-if="run.trigger" class="badge info">{{ run.trigger }}</span>
    </h2>
    <div class="mono-sm" style="color: var(--info)">
      {{ phaseText }}<template v-if="run.current">：{{ run.current }}</template>
      <template v-if="run.running">（{{ (run.entries || []).length }} 个任务）</template>
    </div>
    <div v-if="run.error" class="errors">{{ run.error }}</div>

    <table v-if="(run.results || []).length" class="grid" style="margin-top: 8px">
      <thead>
        <tr><th style="width: 28px" /><th>任务</th><th>结果</th><th style="width: 60px">耗时</th></tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in run.results" :key="i">
          <td>{{ r.ok ? '✔' : '✘' }}</td>
          <td>{{ r.entry }}</td>
          <td class="dim">{{ r.reason || (r.ok ? '通过' : '失败') }}</td>
          <td class="dim">{{ r.elapsed ? r.elapsed + 's' : '' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty" style="margin-top: 8px">本次还没有任务结果</p>
  </section>

  <section class="panel" style="margin-top: 12px">
    <h2>最近运行</h2>
    <p v-if="!(store.state?.runs || []).length" class="empty">还没有运行记录</p>
    <table v-else class="grid">
      <thead>
        <tr><th>开始</th><th>来源</th><th>任务集</th><th>状态</th><th>耗时</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in (store.state?.runs || []).slice(0, 8)" :key="r.id">
          <td class="dim">{{ fmtTime(r.startedAt) }}</td>
          <td class="dim">{{ r.trigger || '—' }}</td>
          <td>{{ r.presetName || `${(r.entries || []).length} 个任务` }}</td>
          <td><span :class="statusBadge(r.status)">{{ r.status || '—' }}</span></td>
          <td class="dim">{{ elapsed(r) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
