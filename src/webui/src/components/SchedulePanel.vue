<script setup>
/**
 * 调度：谁在什么时候会被自动跑。
 *
 * 调度器只在 `ui` 命令里启动（`--no-schedule` 可以关掉），随界面进程生命周期。
 * 到点触发时如果已有任务在跑，会记一条 `skipped` 而不是排队补跑 ——
 * 这是刻意的：开机后堆积一串补跑比漏跑更糟。
 *
 * 定时本身是任务集上的字段，所以这里的「新建」只是把你送到任务集页。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { store, guard, toast } from '../store.js';

const data = ref(null);
const loading = ref(false);

const enabled = computed(() => data.value?.enabled === true);
const jobs = computed(() => data.value?.jobs ?? []);
const history = computed(() => data.value?.history ?? []);

async function load() {
  loading.value = true;
  const r = await guard('读取调度', () => api.schedule());
  loading.value = false;
  if (r.ok) data.value = r.data;
}

async function checkNow() {
  const r = await guard('立即检查一次', () => api.checkSchedule());
  if (!r.ok) return;
  toast(`检查 ${r.data.checked} 个作业，触发 ${r.data.fired}，跳过 ${r.data.skipped}`, 'ok');
  await load();
}

const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');
const resultBadge = (r) => (r === 'fired' ? 'badge ok' : r === 'skipped' ? 'badge warn' : 'badge err');

onMounted(load);
</script>

<template>
  <section class="panel">
    <h2>
      调度
      <span class="spacer" />
      <span class="badge" :class="enabled ? 'ok' : 'warn'">
        {{ enabled ? '调度器已启动' : '本次没启动调度器' }}
      </span>
      <button class="mini ghost" :disabled="loading" @click="load">刷新</button>
      <button class="mini" :disabled="!enabled" @click="checkNow">立即检查一次</button>
    </h2>

    <p v-if="!enabled" class="notice">
      本次是用 <span class="mono-sm">--no-schedule</span> 启动的，或者没有用 <span class="mono-sm">ui</span> 命令。
      定时任务只在 <span class="mono-sm">npm run ui</span> 的进程里生效。
    </p>

    <p v-if="!jobs.length" class="empty" style="margin-top: 10px">
      还没有定时任务。到「任务集」页给某个任务集打开「定时」并填 cron（分 时 日 月 周，本地时区）。
    </p>

    <table v-else class="grid" style="margin-top: 8px">
      <thead>
        <tr><th>任务集</th><th>cron</th><th>下次触发</th><th>状态</th></tr>
      </thead>
      <tbody>
        <tr v-for="j in jobs" :key="j.presetId">
          <td>{{ j.name }} <span class="dim mono-sm">{{ j.presetId }}</span></td>
          <td class="mono-sm">{{ j.cron }}</td>
          <td class="dim">{{ j.nextText || '—' }}</td>
          <td>
            <span v-if="!j.ok" class="badge err">{{ j.error }}</span>
            <span v-else class="badge ok">有效</span>
          </td>
        </tr>
      </tbody>
    </table>

    <h3 style="font-size: 12px; color: var(--dim); margin: 16px 0 6px">历史（最近 50 条，同时写入 debug/schedule.jsonl）</h3>
    <p v-if="!history.length" class="empty">还没有触发记录</p>
    <table v-else class="grid">
      <thead>
        <tr><th>时间</th><th>任务集</th><th>结果</th><th>说明</th></tr>
      </thead>
      <tbody>
        <tr v-for="(h, i) in history" :key="i">
          <td class="dim">{{ fmt(h.ts) }}</td>
          <td>{{ h.name || h.presetId }}</td>
          <td><span :class="resultBadge(h.result)">{{ h.result }}</span></td>
          <td class="dim">{{ h.reason || '—' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
