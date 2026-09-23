<script setup>
/**
 * 流水线编辑：改 `resource/pipeline/*.json`。
 *
 * 最有用的东西是「节点详情」——它来自 `resource.get_node_data_parsed()`，
 * 也就是**框架合并默认值之后**的节点定义。手写的 JSON 里看不到
 * `rate_limit` / `max_hit` / 展开后的 `pre_wait_freezes` / 解析后的 `next` 前缀，
 * 而这些恰恰是「为什么这个节点不按我想的走」的答案。
 *
 * 保存走 PUT 并带 mtime：文件被别人改过会返回 409，不静默覆盖。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { guard, isBusy, toast } from '../store.js';

const overview = ref(null);
const base = ref('');
const doc = ref(null);
const text = ref('');
const checkResult = ref(null);
const selectedNode = ref('');
const nodeFilter = ref('');
const loadingDoc = ref(false);

const busy = computed(() => isBusy());
const dirty = computed(() => !!doc.value && text.value !== doc.value.text);

const filteredIndex = computed(() => {
  const list = overview.value?.index ?? [];
  const q = nodeFilter.value.trim();
  if (!q) return list;
  return list.filter((n) => n.node.includes(q) || n.base.includes(q));
});

const nodeDetail = computed(() => {
  const d = doc.value?.details;
  if (!d || !selectedNode.value) return null;
  return d[selectedNode.value] ?? null;
});

async function loadOverview() {
  const r = await guard('读取流水线概览', () => api.pipelines());
  if (!r.ok) return;
  overview.value = r.data;
  if (!base.value && r.data.docs?.length) await openDoc(r.data.docs[0].base);
}

async function openDoc(next) {
  loadingDoc.value = true;
  const r = await guard(`打开流水线「${next}」`, () => api.pipeline(next));
  loadingDoc.value = false;
  if (!r.ok) return;
  base.value = next;
  doc.value = r.data;
  text.value = r.data.text ?? '';
  checkResult.value = { errors: r.data.errors ?? [], warnings: r.data.warnings ?? [] };
  selectedNode.value = r.data.nodes?.[0] ?? '';
}

async function validate() {
  const r = await guard('校验流水线', () => api.validatePipeline(base.value, text.value));
  if (!r.ok) return;
  checkResult.value = r.data;
  const errs = r.data.errors?.length ?? 0;
  toast(errs ? `校验未通过：${errs} 处` : '校验通过', errs ? 'warn' : 'ok');
}

async function save() {
  const r = await guard('保存流水线', () => api.savePipeline(base.value, text.value, doc.value.mtime));
  if (!r.ok) {
    if (r.error?.status === 409) toast('文件已被外部修改，请先「重新加载」再改', 'warn');
    return;
  }
  toast(`已保存（${r.data.nodes?.length ?? 0} 个节点，备份 ${r.data.backup ?? '无'}）`, 'ok');
  await openDoc(base.value);
  await loadOverview();
}

function format() {
  try {
    text.value = JSON.stringify(JSON.parse(text.value), null, 2) + '\n';
    toast('已按 JSON 格式化', 'ok');
  } catch (e) {
    toast(`不是合法 JSON：${e.message}`, 'error');
  }
}

onMounted(loadOverview);
</script>

<template>
  <section class="panel">
    <h2>
      流水线
      <span class="spacer" />
      <span v-if="overview" class="dim">
        {{ overview.docs?.length ?? 0 }} 个文件 · {{ overview.totalNodes ?? 0 }} 个节点
      </span>
      <button class="mini ghost" @click="loadOverview">刷新</button>
    </h2>

    <div v-if="!overview" class="empty">读取中…</div>

    <template v-else>
      <div class="row tight" style="margin-top: 0; flex-wrap: wrap">
        <button
          v-for="d in overview.docs"
          :key="d.base"
          class="mini"
          :class="{ primary: d.base === base }"
          :title="d.file"
          @click="openDoc(d.base)"
        >
          {{ d.base }}
          <span v-if="!d.ok" class="badge err">✘</span>
          <span v-else class="dim">{{ d.nodes?.length ?? 0 }}</span>
        </button>
      </div>

      <p v-if="(overview.orphans || []).length" class="warn-line dim" style="margin-top: 8px">
        孤立节点（没有任何 next/on_error 指向，只能作为入口被调用）：
        <span class="mono-sm">{{ overview.orphans.join('、') }}</span>
      </p>

      <div v-if="loadingDoc" class="empty">打开中…</div>

      <template v-if="doc">
        <p class="panel-sub mono-sm wrap-anywhere">
          {{ doc.file }} · mtime {{ new Date(doc.mtime).toLocaleString('zh-CN', { hour12: false }) }}
          <span v-if="dirty" class="badge warn">有未保存改动</span>
        </p>

        <div v-if="checkResult?.errors?.length" class="errors">
          {{ checkResult.errors.map((e) => (e.path ? `${e.path}：${e.message}` : e.message)).join('\n') }}
        </div>
        <div v-if="checkResult?.warnings?.length" class="warnings">
          {{ checkResult.warnings.map((e) => (e.path ? `${e.path}：${e.message}` : e.message)).join('\n') }}
        </div>

        <div class="row tight" style="margin-top: 8px">
          <button class="mini" :disabled="busy" @click="validate">只校验</button>
          <button class="mini primary" :disabled="busy || !dirty" @click="save">保存</button>
          <button class="mini" :disabled="busy" @click="format">格式化</button>
          <button class="mini ghost" :disabled="!dirty" @click="text = doc.text">还原</button>
          <span class="spacer" style="flex: 1" />
          <span class="dim">{{ text.length }} 字符</span>
        </div>

        <textarea v-model="text" rows="22" spellcheck="false" style="margin-top: 8px" />

        <h3 style="font-size: 12px; color: var(--dim); margin: 14px 0 6px">节点详情（框架合并默认值后）</h3>
        <div class="row tight" style="margin-top: 0">
          <select v-model="selectedNode" class="grow" style="max-width: 320px">
            <option v-for="n in doc.nodes" :key="n" :value="n">{{ n }}</option>
          </select>
          <span class="dim">共 {{ doc.nodes?.length ?? 0 }} 个节点</span>
        </div>
        <div v-if="!doc.details" class="notice" style="margin-top: 8px">
          取不到节点详情（执行层没能加载资源）。正文与校验仍然可用。
        </div>
        <template v-else-if="nodeDetail">
          <div v-if="nodeDetail.ok === false" class="errors">这个节点有问题：{{ nodeDetail.error }}</div>
          <pre
            v-else
            class="log-box"
            style="height: auto; max-height: 320px; margin-top: 8px"
          >{{ JSON.stringify(nodeDetail.merged, null, 2) }}</pre>
        </template>
        <p v-else-if="doc.details" class="empty" style="margin-top: 8px">这个节点没有详情</p>
      </template>

      <h3 style="font-size: 12px; color: var(--dim); margin: 16px 0 6px">节点索引（谁引用了谁）</h3>
      <input v-model="nodeFilter" placeholder="按节点名或文件过滤…">
      <div style="max-height: 260px; overflow: auto; margin-top: 8px">
        <table class="grid">
          <thead>
            <tr><th>节点</th><th>所在文件</th><th>重复定义</th><th>被引用</th></tr>
          </thead>
          <tbody>
            <tr v-for="n in filteredIndex" :key="n.base + ':' + n.node">
              <td class="mono-sm">{{ n.node }}</td>
              <td class="dim mono-sm">{{ n.base }}</td>
              <td>
                <span v-if="(n.duplicatedIn || []).length" class="badge err">{{ n.duplicatedIn.join('、') }}</span>
                <span v-else class="dim">—</span>
              </td>
              <td class="dim">
                <span v-if="!(n.referencedBy || []).length">入口节点（无人引用）</span>
                <template v-else>
                  <span v-for="(r, i) in n.referencedBy" :key="i" class="mono-sm">
                    {{ r.base }}:{{ r.node }}.{{ r.field }}<span v-if="i < n.referencedBy.length - 1">、</span>
                  </span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.warn-line { color: var(--warn); font-size: 12px; }
</style>
