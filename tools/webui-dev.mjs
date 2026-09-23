/**
 * 起控制台的开发服务器（Vite dev + 热更新），接口反向代理到 `npm run ui`。
 *
 * 和 `tools/webui-build.mjs` 一样把配置对象直接传进去（`configFile: false`），
 * 避免 Vite 用自己的解析器加载配置文件时踩到 Windows 网络驱动器探测
 * （受限沙箱里 `spawn` 被拒 → `EPERM`）。详见 `src/webui/vite.config.mjs`。
 *
 * 用法：
 *   npm run ui                      # 终端 A：后端 + 接口（默认 8848）
 *   npm run webui:dev               # 终端 B：前端热更新（默认 5273）
 *   WJDR_UI_BACKEND=http://127.0.0.1:8899 npm run webui:dev   # 后端换端口时
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'src', 'webui', 'vite.config.mjs');

const { createServer } = await import('vite');
const userConfig = (await import(pathToFileURL(CONFIG_FILE).href)).default;

const server = await createServer({ ...userConfig, configFile: false });
await server.listen();
server.printUrls();
