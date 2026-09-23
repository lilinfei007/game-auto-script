<script setup>
/**
 * 实时画面 + 手动操作 + 单节点试跑。
 *
 * 两个关键约束（都在后端强制，这里只是让它们「看得见」）：
 *  - 画面与手动操作共用执行层的控制器，任务运行期间一律 409；
 *  - 单节点试跑复用常驻控制器与资源缓存，所以「改完流水线立刻试跑」
 *    看到的一定是新内容（保存流水线会让资源缓存失效）。
 *
 * 截图走 fetch 而不是 <img src>：需要同时拿到 503 时的错误文案
 * 与 X-Image-Width/Height（点击换算成设备坐标要用真实分辨率）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, errorText } from '../api.js';
import { store, guard, isBusy, toast } from '../store.js';

const POLL_MS = 1000;

const instance = ref(0);
const liveOn = ref(false);
const shotUrl = ref('');
const shotSize = ref({ width: 0, height: 0 });
const shotError = ref('');
const busy = ref(false);
const nodes = ref([]);
const nodeName = ref('');
const nodeTimeoutMs = ref(60000);

const config = computed(() => store.state?.config ?? {});
const instances = computed(() => config.value.instances ?? []);
const running = computed(() => isBusy());
const device = computed(() => store.state?.device ?? null);

let timer = null;
const dragging = ref(null);
let objectUrl = null;

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

function releaseUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

async function grabShot() {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch(api.liveShotUrl(instance.value), { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      shotError.value = body?.error || `HTTP ${res.status}`;
      releaseUrl();
      shotUrl.value = '';
      return;
    }
    const blob = await res.blob();
    const w = Number(res.headers.get('x-image-width')) || 0;
    const h = Number(res.headers.get('x-image-height')) || 0;
    const next = URL.createObjectURL(blob);
    releaseUrl();
    objectUrl = next;
    shotUrl.value = next;
    shotSize.value = { width: w, height: h };
    shotError.value = '';
  } catch (e) {
    shotError.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

function startPolling() {
  stopPolling();
  grabShot();
  timer = setInterval(grabShot, POLL_MS);
}

async function startLive() {
  const r = await guard('打开实时画面', () => api.liveStart({ instance: instance.value }));
  if (r.ok) {
    liveOn.value = true;
    startPolling();
  }
}

async function stopLive() {
  await guard('释放实时画面', () => api.liveStop());
  liveOn.value = false;
  stopPolling();
  releaseUrl();
  shotUrl.value = '';
}

/** 把鼠标位置换算成设备坐标（画面可能被 CSS 缩放过）。 */
function toDeviceCoords(ev) {
  const img = ev.currentTarget;
  const rect = img.getBoundingClientRect();
  const w = shotSize.value.width || img.naturalWidth || rect.width;
  const h = shotSize.value.height || img.naturalHeight || rect.height;
  const x = ((ev.clientX - rect.left) / rect.width) * w;
  const y = ((ev.clientY - rect.top) / rect.height) * h;
  return [Math.round(x), Math.round(y)];
}

function onPointerDown(ev) {
  if (!liveOn.value || running.value) return;
  const [x, y] = toDeviceCoords(ev);
  dragging.value = { from: [x, y], at: { x: ev.clientX, y: ev.clientY }, moved: false };
  ev.currentTarget.setPointerCapture?.(ev.pointerId);
}

function onPointerMove(ev) {
  if (!dragging.value) return;
  if (Math.abs(ev.clientX - dragging.value.at.x) + Math.abs(ev.clientY - dragging.value.at.y) > 8) {
    dragging.value.moved = true;
  }
}

async function onPointerUp(ev) {
  if (!dragging.value) return;
  const from = dragging.value.from;
  const moved = dragging.value.moved;
  dragging.value = null;
  const [x, y] = toDeviceCoords(ev);
  if (!moved) {
    const r = await guard(`点击 (${x}, ${y})`, () =>
      api.tap({ x, y, instance: instance.value }),
    );
    if (r.ok) toast(`已点击 ${x}, ${y}`, 'ok');
    return;
  }
  const r = await guard('滑动', () =>
    api.swipe({ from, to: [x, y], durationMs: 300, instance: instance.value }),
  );
  if (r.ok) toast(`已滑动 ${from.join(',')} → ${x},${y}`, 'ok');
}

async function runNode() {
  if (!nodeName.value) return;
  const r = await guard(`试跑节点「${nodeName.value}」`, () =>
    api.runNode({
      node: nodeName.value,
      instance: instance.value,
      timeoutMs: Number(nodeTimeoutMs.value) || undefined,
    }),
  );
  if (r.ok) toast(`已开始试跑「${nodeName.value}」，日志见「日志」页`, 'ok');
}

async function loadNodes() {
  const r = await guard('读取流水线节点', () => api.pipelines());
  if (r.ok) {
    nodes.value = (r.data.index ?? []).map((n) => n.node);
    if (!nodeName.value && nodes.value.length) nodeName.value = nodes.value[0];
  }
}

onMounted(() => {
  if (instances.value.length) instance.value = instances.value[0].index;
  loadNodes();
  if (device.value?.live) {
    liveOn.value = true;
    startPolling();
  }
});

onUnmounted(() => {
  stopPolling();
  releaseUrl();
});
</script>

<template>
  <section class="panel">
    <h2>
      实时画面
      <span class="spacer" />
      <span v-if="device" class="badge" :class="device.ready ? 'ok' : 'err'">
        {{ device.ready ? '设备就绪' : '设备未就绪' }}
      </span>
      <span v-if="running" class="badge warn">任务运行中，手动操作被拒绝</span>
    </h2>

    <div class="row tight" style="margin-top: 0">
      <select v-model.number="instance" :disabled="liveOn" style="max-width: 220px">
        <option v-for="i in instances" :key="i.index" :value="i.index">[{{ i.index }}] {{ i.address }}</option>
        <option v-if="!instances.length" :value="0">（配置里没有实例）</option>
      </select>
      <button v-if="!liveOn" class="primary" :disabled="running" @click="startLive">打开画面</button>
      <button v-else @click="stopLive">关闭画面</button>
      <span class="dim">
        {{ shotSize.width ? `${shotSize.width}×${shotSize.height}` : '' }}
      </span>
      <span class="spacer" style="flex: 1" />
      <span class="dim">{{ liveOn ? '每秒刷新' : '未开启' }}</span>
    </div>

    <div v-if="shotError" class="errors">{{ shotError }}</div>

    <div style="margin-top: 10px">
      <div v-if="!liveOn" class="screen-hint">
        点「打开画面」建立常驻控制器。之后可以直接在画面上点按 / 拖拽来操作模拟器。
      </div>
      <div v-else-if="!shotUrl" class="screen-hint">正在取画面…</div>
      <div v-else class="screen-wrap" :class="{ busy: running }">
        <img
          :src="shotUrl"
          alt="模拟器实时画面"
          draggable="false"
          :style="{ cursor: running ? 'not-allowed' : 'crosshair', maxHeight: '70vh' }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="dragging = null"
        >
      </div>
    </div>
  </section>

  <section class="panel" style="margin-top: 12px">
    <h2>
      单节点试跑
      <span class="spacer" />
      <button class="mini ghost" @click="loadNodes">刷新节点</button>
    </h2>
    <p class="panel-sub">
      复用常驻控制器与资源缓存，用来验证刚改过的流水线节点；不算一次完整运行，不产生运行记录。
    </p>
    <div class="row tight" style="margin-top: 0">
      <select v-model="nodeName" class="grow" :disabled="running">
        <option v-for="n in nodes" :key="n" :value="n">{{ n }}</option>
        <option v-if="!nodes.length" value="">（没有节点）</option>
      </select>
      <input v-model.number="nodeTimeoutMs" type="number" min="1000" step="1000" style="max-width: 120px" :disabled="running">
      <button :disabled="running || !nodeName" @click="runNode">试跑</button>
    </div>
  </section>
</template>
