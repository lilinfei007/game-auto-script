<script setup>
/**
 * 任务集编辑：`config/tasks.json` 的图形化编排。
 *
 * 与「临时勾选模块」的区别是这里编出来的东西是**持久且可复用**的：
 * 有序步骤（可开关、可单独设超时、可贴标签）、默认实例/重试、定时。
 *
 * 写入全部走后端：
 *  - 元信息（名称/开关/实例/重试/定时）走 `PUT /api/tasks/presets/:id`
 *  - 步骤增删改序走 `POST /api/tasks/presets/:id/steps`（ops 数组）
 * 两端都带 mtime 冲突检测，返回 409 表示「文件被别人改过」，界面提示重新加载。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api.js';
import { store, guard, isBusy, toast } from '../store.js';

const tasks = ref(null);
const drafts = reactive({});
const loading = ref(false);
const newName = ref('');
const addEntry = reactive({});

const modules = computed(() => store.state?.modules ?? []);
const busy = computed(() => isBusy());

/** 步骤在 preset 里的「同名出现次序」——ops 接口按它定位（不是数组下标）。 */
function ordinal(steps, i) {
  const target = steps[i].raw;
  let seen = 0;
  for (let k = 0; k < i; k++) if (steps[k].raw === target) seen++;
  return seen;
}

async function load() {
  loading.value = true;
  const r = await guard('读取任务集', () => api.tasks());
  loading.value = false;
  if (!r.ok) return;
  tasks.value = r.data;
  syncDrafts();
}

function syncDrafts() {
  for (const p of tasks.value?.presets ?? []) {
    drafts[p.id] = {
      name: p.name,
      enabled: p.enabled,
      instance: p.instance ?? '',
      retry: p.retry ?? '',
      cronEnabled: !!p.schedule?.enabled,
      cron: p.schedule?.cron ?? '',
      timezone: p.schedule?.timezone ?? 'local',
    };
  }
}

/** 写操作成功后后端会回新的 presets，直接替换，避免再多一次 GET。 */
function applyPresets(presets) {
  if (tasks.value) tasks.value.presets = presets;
  syncDrafts();
}

async function runPreset(p) {
  const r = await guard(`执行任务集「${p.name}」`, () => api.runPreset(p.id, {}));
  if (r.ok) toast(`已开始：${p.name}`, 'ok');
}

async function createPreset() {
  const r = await guard('新建任务集', () => api.createPreset({ name: newName.value.trim() || undefined }));
  if (!r.ok) return;
  newName.value = '';
  applyPresets(r.data.presets);
  toast('已新建任务集（默认带上所有可跑模块）', 'ok');
}

async function saveMeta(p) {
  const d = drafts[p.id];
  const r = await guard(`保存任务集「${d.name}」`, () =>
    api.updatePreset(p.id, {
      name: d.name,
      enabled: !!d.enabled,
      instance: d.instance === '' ? null : Number(d.instance),
      retry: d.retry === '' ? null : Number(d.retry),
      schedule: {
        enabled: !!d.cronEnabled,
        cron: d.cronEnabled ? d.cron.trim() : '',
        timezone: d.timezone || 'local',
      },
    }),
  );
  if (r.ok) {
    applyPresets(r.data.presets);
    toast('已保存', 'ok');
  }
}

async function removePreset(p) {
  if (!window.confirm(`删除任务集「${p.name}」？`)) return;
  const r = await guard(`删除任务集「${p.name}」`, () => api.deletePreset(p.id));
  if (r.ok) {
    applyPresets(r.data.presets);
    toast('已删除', 'ok');
  }
}

async function stepOp(p, ops, label) {
  const r = await guard(label, () => api.stepOps(p.id, ops));
  if (r.ok) applyPresets(r.data.presets);
}

const opBase = (p, step, i) => ({ entry: step.raw, index: ordinal(p.steps, i) });

function move(p, step, i, delta) {
  stepOp(p, [{ op: 'move', ...opBase(p, step, i), delta }], `移动步骤「${step.entry}」`);
}

function toggle(p, step, i) {
  stepOp(
    p,
    [{ op: 'toggle', ...opBase(p, step, i), enabled: !step.enabled }],
    `${step.enabled ? '停用' : '启用'}步骤「${step.entry}」`,
  );
}

function removeStep(p, step, i) {
  stepOp(p, [{ op: 'remove', ...opBase(p, step, i) }], `删除步骤「${step.entry}」`);
}

function editLabel(p, step, i) {
  const next = window.prompt(`给「${step.entry}」起个标签（留空则清除，最多 64 字）`, step.label ?? '');
  if (next === null) return;
  stepOp(p, [{ op: 'label', ...opBase(p, step, i), label: next.trim() }], '修改标签');
}

function editTimeout(p, step, i) {
  const cur = step.timeoutMs ? String(step.timeoutMs) : '';
  const next = window.prompt(
    `「${step.entry}」的单步超时（毫秒，留空或 0 表示用 runtime.taskTimeoutMs）`,
    cur,
  );
  if (next === null) return;
  const trimmed = next.trim();
  const value = trimmed === '' ? null : Number(trimmed);
  if (value !== null && (!Number.isInteger(value) || value <= 0)) {
    toast('超时必须是正整数毫秒数，或留空', 'warn');
    return;
  }
  stepOp(p, [{ op: 'timeout', ...opBase(p, step, i), timeoutMs: value }], '修改单步超时');
}

function addStep(p) {
  const entry = addEntry[p.id];
  if (!entry) {
    toast('先选一个模块', 'warn');
    return;
  }
  stepOp(p, [{ op: 'add', entry, enabled: true }], `添加步骤「${entry}」`);
  addEntry[p.id] = '';
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <h2>
      任务集
      <span class="spacer" />
      <button class="mini ghost" :disabled="loading" @click="load">重新加载</button>
    </h2>

    <div v-if="!tasks" class="empty">{{ loading ? '读取中…' : '还没读取' }}</div>

    <template v-else>
      <p class="panel-sub mono-sm wrap-anywhere">
        {{ tasks.file }}
        <template v-if="tasks.mtime"> · mtime {{ new Date(tasks.mtime).toLocaleString('zh-CN', { hour12: false }) }}</template>
        <template v-if="tasks.exists === false"> · <span class="badge warn">文件还不存在，第一次保存时创建</span></template>
      </p>
      <div v-if="(tasks.errors || []).length" class="errors">{{ tasks.errors.join('\n') }}</div>
      <div v-if="(tasks.warnings || []).length" class="warnings">{{ tasks.warnings.join('\n') }}</div>
      <p class="dim">
        默认：实例 {{ tasks.defaults?.instance ?? '—' }} · 重试 {{ tasks.defaults?.retry ?? '—' }} ·
        总超时 {{ tasks.defaults?.taskTimeoutMs ?? '—' }}ms
      </p>

      <div class="row tight">
        <input v-model="newName" class="grow" placeholder="新任务集名称（留空自动生成）" @keyup.enter="createPreset">
        <button class="primary" @click="createPreset">新建</button>
      </div>

      <p v-if="!tasks.presets.length" class="empty" style="margin-top: 12px">
        还没有任务集。新建一个，它会默认带上当前所有可跑模块，再按需要调顺序/开关/超时。
      </p>

      <div class="list" style="margin-top: 12px">
        <div v-for="p in tasks.presets" :key="p.id" class="card">
          <div class="card-head">
            <span class="badge" :class="p.runnable ? 'ok' : 'warn'">{{ p.runnable ? '可执行' : '没有启用步骤' }}</span>
            <span class="mono-sm dim">{{ p.id }}</span>
            <span v-if="p.broken?.length" class="badge err">失效步骤 {{ p.broken.length }}</span>
            <span class="spacer" />
            <button class="mini" :disabled="busy || !p.runnable" @click="runPreset(p)">执行</button>
            <button class="mini danger" :disabled="busy" @click="removePreset(p)">删除</button>
          </div>

          <div class="row tight">
            <input v-model="drafts[p.id].name" class="grow" placeholder="名称">
            <label class="dim" style="display: flex; gap: 5px; align-items: center; white-space: nowrap">
              <input v-model="drafts[p.id].enabled" type="checkbox" style="width: auto">启用
            </label>
          </div>
          <div class="row tight">
            <input v-model="drafts[p.id].instance" type="number" min="0" placeholder="实例（默认）" style="max-width: 150px">
            <input v-model="drafts[p.id].retry" type="number" min="0" max="5" placeholder="重试（默认）" style="max-width: 150px">
            <label class="dim" style="display: flex; gap: 5px; align-items: center; white-space: nowrap">
              <input v-model="drafts[p.id].cronEnabled" type="checkbox" style="width: auto">定时
            </label>
            <input
              v-model="drafts[p.id].cron"
              class="grow mono-sm"
              placeholder="0 8 * * *（分 时 日 月 周）"
              :disabled="!drafts[p.id].cronEnabled"
            >
            <button class="mini" :disabled="busy" @click="saveMeta(p)">保存</button>
          </div>

          <table class="grid" style="margin-top: 8px">
            <thead>
              <tr>
                <th style="width: 30px">#</th>
                <th>入口</th>
                <th>标签</th>
                <th style="width: 90px">单步超时</th>
                <th style="width: 150px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in p.steps" :key="i" :style="{ opacity: s.enabled ? 1 : 0.5 }">
                <td class="dim">{{ i + 1 }}</td>
                <td>
                  <span :class="{ dim: !s.ok }">{{ s.entry }}</span>
                  <span v-if="!s.ok" class="badge err" style="margin-left: 6px">模块不存在（原始值 {{ s.raw }}）</span>
                  <span v-else-if="s.raw !== s.entry" class="dim mono-sm" style="margin-left: 6px">← {{ s.raw }}</span>
                </td>
                <td class="dim">{{ s.label ?? '—' }}</td>
                <td class="dim">{{ s.timeoutMs ? s.timeoutMs + 'ms' : '默认' }}</td>
                <td>
                  <button class="mini ghost" :disabled="busy || i === 0" title="上移" @click="move(p, s, i, -1)">↑</button>
                  <button class="mini ghost" :disabled="busy || i === p.steps.length - 1" title="下移" @click="move(p, s, i, 1)">↓</button>
                  <button class="mini ghost" :disabled="busy" :title="s.enabled ? '停用' : '启用'" @click="toggle(p, s, i)">
                    {{ s.enabled ? '停' : '启' }}
                  </button>
                  <button class="mini ghost" :disabled="busy" title="标签" @click="editLabel(p, s, i)">签</button>
                  <button class="mini ghost" :disabled="busy" title="单步超时" @click="editTimeout(p, s, i)">时</button>
                  <button class="mini ghost danger" :disabled="busy" title="删除" @click="removeStep(p, s, i)">✕</button>
                </td>
              </tr>
              <tr v-if="!p.steps.length">
                <td colspan="5" class="empty">没有步骤</td>
              </tr>
            </tbody>
          </table>

          <div class="row tight">
            <select v-model="addEntry[p.id]" class="grow" :disabled="busy">
              <option value="">添加步骤…（从可跑模块里选）</option>
              <option v-for="m in modules.filter((x) => x.ok)" :key="m.base" :value="m.entry">
                {{ m.base }} → {{ m.entry }}
              </option>
            </select>
            <button class="mini" :disabled="busy || !addEntry[p.id]" @click="addStep(p)">添加</button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
