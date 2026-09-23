/**
 * 控制台（阶段 3）的构建配置。
 *
 * 约定：
 *  - 根目录就是本目录（`src/webui`），产物落在 `src/webui/dist`（已 gitignore）。
 *  - `base: './'` —— 产物用相对路径引用资源，挂在 `/` 或任意子路径下都能跑。
 *  - `npm run webui:dev` 起 Vite 开发服务器，把 `/api` 反向代理到
 *    `node src/index.mjs ui`（默认 8848），这样热更新时接口是真的。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 开发服务器把接口转发到哪个后端（与 `npm run ui` 的默认端口一致）。 */
const backend = process.env.WJDR_UI_BACKEND ?? 'http://127.0.0.1:8848';

export default defineConfig({
  root: here,
  base: './',
  plugins: [vue()],
  resolve: {
    /**
     * 关掉「解析时把软链接还原成真实路径」。
     *
     * Vite 在 Windows 上为了这一步会先探测网络驱动器（同步 `net use`）；
     * 在受限沙箱里 `spawn` 被拒绝，会直接 `EPERM` 让构建失败，
     * 而报错栈指向 `net use` 探测、与真正的前端代码毫无关系。
     * 本项目的依赖是 npm 平铺安装、没有软链接，关掉不影响解析结果。
     */
    preserveSymlinks: true,
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    // 控制台只在本机跑，不需要为老浏览器降级
    target: 'es2022',
  },
  server: {
    // 显式绑 127.0.0.1：默认的 `localhost` 在 Windows 上可能只解析到 ::1，
    // 于是 `http://127.0.0.1:5273` 连不上，排查时会白花时间
    host: '127.0.0.1',
    port: 5273,
    strictPort: false,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
    },
  },
});
