<script setup>
/**
 * 设备与配置。
 *
 * 配置编辑刻意用「整份 JSON」而不是表单：`config.json` 里有
 * 模拟器路径、端口步长、运行时参数、实例列表四块，做成表单会漏字段；
 * 整份 JSON 至少保证「看到的就是保存的」。校验交给后端：
 * 路径不存在只给警告（保存一份指向没装的模拟器的配置是合法的），
 * 真正的体检交给 doctor（严格模式，路径不存在是致命错误）。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { store, guard, isBusy, toast } from '../store.js';

const device = ref(null);
const config = ref(null);
const configText = ref('');
const doctor = ref(null);
const running = computed(() => isBusy());

const dirty = computed(() => !!config.value && configText.value !== JSON.stringify(config.value.config, null, 2) + '\n');

async function loadDevice() {
  const r = await guard('读取设备', () => api.device());
  if (r.ok) device.value = r.data;
}

async function loadConfig() {
  const r = await guard('读取配置', () => api.config());
  if (!r.ok) return;
  config.value = r.data;
  resetConfigText();
}

/** 把编辑框恢复成「磁盘上的那份」；config 还没读到时不动。 */
function resetConfigText() {
  if (!config.value) return;
  configText.value = JSON.stringify(config.value.config, null, 2) + '\n';
}

async function launch(index) {
  const r = await guard(`拉起实例 ${index}`, () => api.launchDevice(index));
  if (r.ok) {
    toast(`已开始拉起实例 ${index}（要等 Android 起来，进度见日志）`, 'ok');
    setTimeout(loadDevice, 3000);
  }
}

async function saveConfig() {
  let parsed;
  try {
    parsed = JSON.parse(configText.value);
  } catch (e) {
    toast(`不是合法 JSON：${e.message}`, 'error');
    return;
  }
  const r = await guard('保存配置', () => api.saveConfig(parsed));
  if (!r.ok) return;
  toast(`已保存（备份 ${r.data.backup ?? '无'}）`, 'ok');
  if (r.data.warnings?.length) toast(`有 ${r.data.warnings.length} 条警告`, 'warn', r.data.warnings.join('\n'));
  await loadConfig();
}

async function runDoctor() {
  const r = await guard('跑环境自检', () => api.doctor());
  if (r.ok) {
    doctor.value = r.data;
    toast(`自检：${r.data.passed}/${r.data.total} 通过${r.data.failedFatal ? `，致命 ${r.data.failedFatal}` : ''}`,
      r.data.failedFatal ? 'error' : r.data.passed === r.data.total ? 'ok' : 'warn');
  }
}

onMounted(() => {
  loadDevice();
  loadConfig();
});
</script>

<template>
  <section class="panel">
    <h2>
      设备
      <span class="spacer" />
      <button class="mini ghost" @click="loadDevice">刷新</button>
    </h2>

    <div v-if="device?.error" class="errors">{{ device.error }}</div>
    <p v-if="device && !device.instances.length" class="empty">
      没有读到 MuMu 实例。检查 <span class="mono-sm">mumu.manager</span> 路径（见下方配置），
      或直接点下面的按钮试一次拉起。
    </p>

    <table v-if="device?.instances?.length" class="grid">
      <thead>
        <tr><th>#</th><th>名称</th><th>地址</th><th>ADB 端口</th><th>状态</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="i in device.instances" :key="i.index">
          <td>{{ i.index }}</td>
          <td>{{ i.name }}{{ i.isMain ? '（主）' : '' }}</td>
          <td class="mono-sm">{{ i.address }}</td>
          <td class="dim">{{ i.adbPort }}</td>
          <td>
            <span class="badge" :class="i.isAndroidStarted ? 'ok' : 'warn'">
              {{ i.isAndroidStarted ? 'Android 已启动' : 'Android 未启动' }}
            </span>
          </td>
          <td>
            <button class="mini" :disabled="running" @click="launch(i.index)">拉起</button>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="device?.current" class="dim" style="margin-top: 8px">
      执行层当前设备：实例 {{ device.current.index }} · {{ device.current.ready ? '就绪' : '未就绪' }} ·
      {{ device.current.live ? '实时画面开着' : '实时画面关着' }}
      <template v-if="device.current.detail"> · {{ device.current.detail }}</template>
    </p>
    <div v-if="!device?.instances?.length" class="row tight">
      <button :disabled="running" @click="launch(0)">尝试拉起实例 0</button>
    </div>
  </section>

  <section class="panel" style="margin-top: 12px">
    <h2>
      配置 config.json
      <span class="spacer" />
      <button class="mini ghost" :disabled="!dirty" @click="resetConfigText">还原</button>
      <button class="mini primary" :disabled="running || !dirty" @click="saveConfig">保存</button>
    </h2>

    <div v-if="!config" class="empty">读取中…</div>
    <template v-else>
      <p class="panel-sub mono-sm wrap-anywhere">{{ config.file }}</p>
      <div v-if="(config.errors || []).length" class="errors">{{ config.errors.join('\n') }}</div>
      <div v-if="(config.warnings || []).length" class="warnings">{{ config.warnings.join('\n') }}</div>
      <textarea v-model="configText" rows="20" spellcheck="false" style="margin-top: 8px" />
    </template>
  </section>

  <section class="panel" style="margin-top: 12px">
    <h2>
      环境自检 doctor
      <span class="spacer" />
      <span v-if="doctor" class="badge" :class="doctor.failedFatal ? 'err' : 'ok'">
        {{ doctor.passed }}/{{ doctor.total }} 通过
      </span>
      <button class="mini primary" :disabled="running" @click="runDoctor">跑一遍</button>
    </h2>
    <p class="panel-sub">严格模式，不碰设备。任务运行期间不能跑。</p>
    <table v-if="doctor" class="grid">
      <thead>
        <tr><th style="width: 30px" /><th>检查项</th><th>结果</th><th style="width: 60px">致命</th></tr>
      </thead>
      <tbody>
        <tr v-for="c in doctor.checks" :key="c.name">
          <td>{{ c.ok ? '✔' : '✘' }}</td>
          <td>{{ c.name }}</td>
          <td :class="c.ok ? 'dim' : 'l-error'">{{ c.detail }}</td>
          <td><span v-if="c.fatal" class="badge warn">是</span></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
