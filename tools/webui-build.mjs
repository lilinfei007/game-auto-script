/**
 * 构建 Web 控制台（`src/webui` → `src/webui/dist`）。
 *
 * 存在的意义是「构建失败不能挡路」：
 *  - `npm run ui` 的 `preui` 钩子会调它。前端依赖在 devDependencies 里，
 *    别人 clone 下来只 `npm install --omit=dev` 时不会有 Vite —— 那种情况下
 *    这里只打一句警告就退出 0，`ui` 继续用 `src/web.mjs` 里的内联页兜底。
 *  - 已经构建过且没有改动时直接跳过（`preui` 不该让每次启动都等一遍打包）。
 *
 * 用 Vite 的 JS API 而不是 `npx vite`，并且**把配置对象直接传进去**
 * （`configFile: false`）：走配置文件时 Vite 会用自己的解析器去加载它，
 * 而那条路径不读 `resolve.preserveSymlinks`，在受限沙箱里会踩到
 * Windows 网络驱动器探测（同步 `net use`）抛 `EPERM` —— 详见
 * `src/webui/vite.config.mjs` 里 `preserveSymlinks` 的注释。
 *
 * 用法：
 *   node tools/webui-build.mjs            # 需要时才构建
 *   node tools/webui-build.mjs --force    # 强制重建（npm run webui:build）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = path.join(ROOT, 'src', 'webui');
const CONFIG_FILE = path.join(UI_DIR, 'vite.config.mjs');

/** 构建产物目录与入口；`tools/build-portable.mjs` 也用它做打包校验。 */
export const WEBUI_DIST = path.join(UI_DIR, 'dist');
export const WEBUI_ENTRY = path.join(WEBUI_DIST, 'index.html');

/** dist 里的 index.html 是否比 src/webui 下任何源文件都新。 */
function isFresh() {
  if (!fs.existsSync(WEBUI_ENTRY)) return false;
  const built = fs.statSync(WEBUI_ENTRY).mtimeMs;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'dist' || e.name === 'node_modules') continue;
        if (!walk(p)) return false;
      } else if (fs.statSync(p).mtimeMs > built) {
        return false;
      }
    }
    return true;
  };
  return walk(UI_DIR);
}

/**
 * 构建控制台。
 *
 * @param {object} [options]
 * @param {boolean} [options.force] 跳过「已最新」判断，强制重建
 * @param {boolean} [options.quiet] 不打印「已是最新 / 构建完成」这类进度信息
 * @returns {Promise<boolean>} 是否产出了可用的构建产物
 */
export async function buildWebui({ force = false, quiet = false } = {}) {
  const info = quiet ? () => {} : (m) => console.log(m);

  if (!fs.existsSync(path.join(UI_DIR, 'index.html'))) {
    console.warn('[webui] 找不到 src/webui/index.html，跳过构建');
    return false;
  }
  if (!force && isFresh()) {
    info('[webui] 控制台已是最新，跳过构建（要强制重建：npm run webui:build）');
    return true;
  }

  let vite;
  let userConfig;
  try {
    vite = await import('vite');
    userConfig = (await import(pathToFileURL(CONFIG_FILE).href)).default;
  } catch (e) {
    console.warn(`[webui] 读不到前端依赖或配置（${e.code ?? e.message}），跳过构建；界面会退回内联页。`);
    console.warn('[webui] 想用 Vue 控制台：npm install（devDependencies 里有 vite 与 @vitejs/plugin-vue）');
    return false;
  }

  const t0 = Date.now();
  try {
    await vite.build({ ...userConfig, configFile: false });
    info(`[webui] 构建完成：${path.relative(ROOT, WEBUI_ENTRY)}（${Date.now() - t0}ms）`);
    return true;
  } catch (e) {
    // 构建失败不该让 `npm run ui` 起不来：内联页仍然可用
    console.warn(`[webui] 构建失败：${e.message}`);
    console.warn('[webui] 界面会退回内联页；修好前端代码后再跑 npm run webui:build');
    return false;
  }
}

// 只有被当作脚本直接运行时才构建；被 build-portable.mjs import 时不该有副作用
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWebui({ force: process.argv.includes('--force') });
}
