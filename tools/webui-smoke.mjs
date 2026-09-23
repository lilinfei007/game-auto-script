/**
 * 控制台冒烟测试：不装浏览器，直接把组件树渲染成 HTML 字符串。
 *
 * 目的不是像素级验证，而是「打开页面不会白屏」：`setup()` 里写错的方法名、
 * 模板里不存在的字段、组件引入路径写错，都会在这里直接抛出来。
 * 交互行为（点按钮、SSE、实时画面）仍然要靠人在浏览器里看。
 *
 * 逐个面板渲染，而不是只渲染外壳：外壳默认只挂「实时画面」一个标签页，
 * 只渲染外壳的话其余六个面板根本不会被执行到。
 *
 * 用 Vite 的 `ssrLoadModule` 而不是先打包：按需编译 SFC，
 * 报错位置直接指到出问题的 .vue 行号。
 *
 * 用法：npm run webui:smoke
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'src', 'webui', 'vite.config.mjs');

/** 每个面板渲染后必须出现的文案。 */
const PANELS = [
  ['App.vue', '外壳', ['运行控制', '实时画面', '任务集', '流水线', '日志', '设备与配置', '调度', '产物']],
  ['components/RunPanel.vue', '运行控制', ['运行控制', '进度', '最近运行', '执行任务集', '每日必做']],
  ['components/LivePanel.vue', '实时画面', ['实时画面', '单节点试跑', '打开画面']],
  ['components/TasksPanel.vue', '任务集', ['任务集', '重新加载', '还没读取']],
  ['components/PipelinePanel.vue', '流水线', ['流水线', '读取中']],
  ['components/LogPanel.vue', '日志', ['日志', '节点', '任务', '自动滚到底']],
  ['components/DevicePanel.vue', '设备与配置', ['设备', '配置 config.json', '环境自检 doctor']],
  ['components/SchedulePanel.vue', '调度', ['调度', '立即检查一次']],
  ['components/ArtifactsPanel.vue', '产物', ['产物', '读取中']],
];

/**
 * 一份假快照，让「运行控制」渲染出有数据的分支。
 *
 * 其余面板的数据是自己 `onMounted` 拉的，而 SSR 不跑 `onMounted`，
 * 所以它们只能渲染「还没读」的空状态 —— 那些有数据的分支由浏览器里
 * 的实际使用覆盖，这里保证的是「模板本身能渲染、不抛错」。
 */
const FAKE_STATE = {
  app: { version: '0.0.0-smoke' },
  config: {
    package: 'com.gof.china',
    shortSide: 720,
    runtime: { shortSide: 720, taskTimeoutMs: 600000 },
    instances: [{ index: 0, enabled: true, address: '127.0.0.1:16384', tasks: [] }],
  },
  modules: [{ file: '00_启动游戏.json', base: '00_启动游戏', entry: '启动游戏', ok: true }],
  presets: [
    {
      id: 'daily',
      name: '每日必做',
      enabled: true,
      enabledCount: 1,
      runnable: true,
      broken: [],
      steps: [{ index: 0, raw: '启动游戏', entry: '启动游戏', ok: true, enabled: true, label: null, timeoutMs: null }],
      schedule: { enabled: false, cron: '', timezone: 'local' },
    },
  ],
  tasksFile: { exists: true, mtime: Date.now(), errors: [] },
  device: null,
  schedule: { enabled: false, jobs: [], history: [] },
  runs: [],
  run: { running: false, phase: 'idle', entries: [], current: null, results: [], status: 'idle' },
};

const { createServer } = await import('vite');
const userConfig = (await import(pathToFileURL(CONFIG_FILE).href)).default;

const server = await createServer({
  ...userConfig,
  configFile: false,
  logLevel: 'warn',
  appType: 'custom',
  server: { middlewareMode: true },
});

let failed = 0;

try {
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('vue/server-renderer');

  // 同一个 SSR 模块图里 App.vue 与各面板共用一份 store 实例
  const { store } = await server.ssrLoadModule('/src/store.js');
  Object.assign(store, { state: FAKE_STATE, loaded: true });

  for (const [file, label, expected] of PANELS) {
    try {
      const mod = await server.ssrLoadModule(`/src/${file}`);
      const html = await renderToString(createSSRApp(mod.default));
      const missing = expected.filter((t) => !html.includes(t));
      if (missing.length) {
        console.error(`✘ ${label}：缺少文案 ${missing.join('、')}`);
        failed++;
      } else {
        console.log(`✔ ${label}（${html.length} 字符）`);
      }
    } catch (e) {
      console.error(`✘ ${label}：渲染时抛错`);
      console.error(e);
      failed++;
    }
  }
} finally {
  await server.close();
}

if (failed > 0) {
  console.error(`冒烟失败：${failed}/${PANELS.length} 个面板有问题`);
  process.exitCode = 1;
} else {
  console.log(`冒烟通过：${PANELS.length} 个面板全部渲染成功`);
}
