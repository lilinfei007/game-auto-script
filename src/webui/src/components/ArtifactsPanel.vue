<script setup>
/**
 * 产物：`debug/` 下的失败截图与识别可视化。
 *
 * 这两类图是排查「为什么这个节点没过」的第一手材料：
 *  - on_error：节点失败瞬间的整屏截图
 *  - draws：识别可视化（框出了 ROI 与命中位置）
 *
 * 图片本身由 `/api/shot?path=` 提供，后端做了目录穿越防护（只允许 debug/ 下的 .png）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import { guard, store } from '../store.js';

const data = ref(null);
const preview = ref('');
const autoRefresh = ref(true);
let timer = null;

const groups = computed(() => [
  { key: 'onError', label: '失败截图', items: data.value?.onError ?? [] },
  { key: 'draws', label: '识别可视化', items: data.value?.draws ?? [] },
]);

async function load() {
  const r = await guard('读取产物列表', () => api.artifacts());
  if (r.ok) data.value = r.data;
}

const fmt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

onMounted(() => {
  load();
  timer = setInterval(() => {
    if (autoRefresh.value) load();
  }, 15000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="panel">
    <h2>
      产物
      <span class="spacer" />
      <label class="dim" style="display: flex; gap: 5px; align-items: center; white-space: nowrap">
        <input v-model="autoRefresh" type="checkbox" style="width: auto">每 15 秒自动刷新
      </label>
      <button class="mini ghost" @click="load">刷新</button>
    </h2>

    <p class="panel-sub">
      {{ store.state?.config?.runtime?.saveOnError ? '当前配置：失败时保存截图' : '当前配置：失败时不保存截图' }} ·
      {{ store.state?.config?.runtime?.saveDraws ? '保存识别可视化' : '不保存识别可视化' }}
      （在「设备与配置」里改）
    </p>

    <div v-if="!data" class="empty">读取中…</div>

    <template v-else>
      <template v-for="g in groups" :key="g.key">
        <h3 style="font-size: 12px; color: var(--dim); margin: 12px 0 6px">
          {{ g.label }}（{{ g.items.length }}）
        </h3>
        <p v-if="!g.items.length" class="empty">暂无</p>
        <div v-else class="shots">
          <a
            v-for="f in g.items"
            :key="f.rel"
            :href="api.shotUrl(f.rel)"
            target="_blank"
            rel="noreferrer"
            :title="`${f.name}\n${fmt(f.mtime)} · ${kb(f.size)}`"
            @click.prevent="preview = api.shotUrl(f.rel)"
          >
            <img :src="api.shotUrl(f.rel)" :alt="f.name" loading="lazy">
          </a>
        </div>
      </template>
    </template>
  </section>

  <div
    v-if="preview"
    style="position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px"
    @click="preview = ''"
  >
    <img :src="preview" style="max-width: 100%; max-height: 100%; border: 1px solid var(--line)" alt="预览">
  </div>
</template>
