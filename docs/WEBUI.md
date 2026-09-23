# Web 控制台：接口契约与扩展指南

这份文档面向「以后要自己改这个平台」的人。界面分两层，但**下面这套 HTTP/SSE 契约
对两层都成立**，所以照着它写前端 / 加接口都不会白写：

- **控制台**（阶段 3，已完成）：`src/webui/` 的 Vue 3 + Vite 工程，`ui` 默认就挂它。
- **内联兜底页**：`src/web.mjs` 底部的单页 HTML（无构建、无依赖）。没装前端依赖
  或构建失败时自动回落，保证 `npm run ui` 永远能用。

工程结构、构建 / 开发 / 冒烟命令见 [第 4 节](#4-改界面加面板)。

---

## 1. 数据分层（先搞清这个，再谈接口）

| 文件 | 管什么 | 归属 | 是否入库 |
|---|---|---|---|
| `config/config.json` | 设备路径、ADB 端口、运行参数、实例列表 | 跟**机器**绑定 | 入库（但换电脑要改） |
| `config/tasks.json` | 任务集：跑什么、什么顺序、哪个开着、单步超时、定时 | 跟**玩法**绑定 | **不入库**（个人配置） |
| `resource/pipeline/*.json` | 流水线节点定义 | 跟**游戏界面**绑定 | 入库 |
| `debug/**` | 日志、失败截图、录制、备份、调度历史 | 运行期产物 | 不入库 |

分层的原因很实际：`config.json` 换了电脑就要改，任务集换了玩法才改，
混在一个文件里会让界面保存时互相覆盖。

### 任务集 schema（`config/tasks.json`）

```jsonc
{
  "version": 1,
  "defaults": { "instance": 0, "retry": 0, "taskTimeoutMs": 600000 },
  "presets": [
    {
      "id": "daily",                    // ^[a-z0-9][a-z0-9_-]{0,31}$
      "name": "每日必做",
      "enabled": true,
      "instance": 0,                    // 省略则用 defaults.instance
      "retry": 0,                       // 0-5，失败后重试（重试前先回主界面）
      "runtime": { "saveFailureShot": true },  // 运行时参数覆盖，不写回 config.json
      "steps": [
        { "entry": "联盟日常", "enabled": true, "label": "联盟互助+宝箱", "timeoutMs": 300000 }
      ],
      "schedule": { "enabled": false, "cron": "0 8 * * *", "timezone": "local" }
    }
  ]
}
```

- `entry` 可以是**节点名**（`联盟日常`）也可以是**流水线文件名**（`10_联盟日常`），
  后者会被解析成该文件的第一个节点。
- `steps[].timeoutMs` 是**单步超时**：只作用于这一个任务的执行上限，
  优先于 `runtime.taskTimeoutMs`。
- `steps` 的顺序就是执行顺序；`enabled: false` 的步骤会被跳过（不删掉，方便临时关）。
- `cron` 是标准 5 段（分 时 日 月 周），只支持本地时区。

### 入参优先级

```
请求体显式给的值  >  preset 上的字段  >  config.runtime / config.instances
```

所以「临时把重试改成 2 再跑一次」不需要动任务集。

---

## 2. HTTP 接口

所有接口都在同一个 origin 下。**写操作**（POST/PUT/PATCH/DELETE）会经过两道门：

1. `Origin` 校验：来源不是本机回环地址 → `403`（防 DNS rebinding）
2. 令牌校验：服务以 `--allow-remote` 启动时，缺少/错误的 `X-Token` → `401`

`GET` 只受第一道门之外的宽松处理 —— 不校验令牌（实时画面要每秒轮询截图）。

### 状态与运行

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 控制台页面（`src/webui/dist` 的构建产物；没有时回落到内联页） |
| GET | `/assets/*` | 控制台静态资源（带内容哈希，可长缓存；缺失返回 404 而不是回落 HTML） |
| GET | `/api/state` | 全量快照：配置、模块、任务集、设备、调度、最近 20 次运行 |
| GET | `/api/events` | SSE：`snapshot` / `log` / `node` / `task` / `state` / `device` / `schedule` / `run` |
| POST | `/api/run` | 执行。body：`{steps?, tasks?, instance?, retry?, runtime?}` → `202` |
| POST | `/api/stop` | 中断当前任务 → `{stopping:true}`；空闲时 `409` |
| POST | `/api/nodes/run` | 单节点试跑（调试用）。body `{node, instance?, timeoutMs?}` → `202` |
| GET | `/api/artifacts` | 失败截图 / 识别可视化列表 |
| GET | `/api/shot?path=` | 取 `debug/` 下的 PNG（有目录穿越防护） |

`/api/run` 的编排语义：`steps` 决定顺序与开关，`tasks` 是 CLI 风格简写，
两者都不给则走 `instances[].tasks`，再退回自动发现（与 CLI 完全一致）。

`/api/nodes/run` **不算一次完整运行**（不产生运行记录），但同样占用控制器锁，
并且复用执行层已有的控制器与资源缓存 —— 所以「改完流水线立刻试跑这个节点」
看到的一定是最新内容（保存流水线时会调 `invalidateResource()` 让缓存失效）。

### 任务集

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 任务集全文 + 每个 preset 的解析视图（`runnable` / `broken`）+ `mtime` |
| POST | `/api/tasks/presets` | 新建。body 可省（自动生成 id 与步骤）；`{id}` 重复 → `409` |
| PUT | `/api/tasks/presets/:id` | 覆盖单个 preset |
| DELETE | `/api/tasks/presets/:id` | 删除 |
| POST | `/api/tasks/presets/:id/steps` | 步骤操作，见下 |
| POST | `/api/tasks/presets/:id/run` | 用该任务集执行 → `202` |

`steps` 接口支持批量 `ops`，也支持 `{order:[...]}` / `{entry, enabled}` 简写：

```jsonc
{ "ops": [
  { "op": "reorder", "order": ["联盟日常", "启动游戏"] },  // 集合必须完全一致
  { "op": "toggle",  "entry": "启动游戏", "enabled": false },
  { "op": "move",    "entry": "联盟日常", "delta": -1 },
  { "op": "timeout", "entry": "联盟日常", "timeoutMs": 300000 },  // null 表示清除
  { "op": "label",   "entry": "联盟日常", "label": "联盟互助" },
  { "op": "remove",  "entry": "启动游戏" },
  { "op": "add",     "entry": "回到主界面", "enabled": true }
] }
```

失败时返回 `422` 与**逐条**错误（`errors: [...]`），界面可以一次性显示。
`mtime` 与磁盘不符时返回 `409` —— 意思是「这个文件被别人改过，请重新加载」，
不会静默覆盖。

### 流水线编辑

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/pipelines` | 文件概览 + 节点索引 + 引用统计 + 孤立节点 |
| GET | `/api/pipelines/:base` | 正文 + 校验 + **节点详情**（框架合并默认值后的实际生效字段） |
| POST | `/api/pipelines/:base` | 只校验不保存：body `{text}` 或 `{json}` |
| PUT | `/api/pipelines/:base` | 保存：body `{text, mtime?}` → `422` 校验失败 / `409` mtime 冲突 |

`:base` 是不带扩展名的文件基名（`_common`、`10_联盟日常`）。
只允许写**已存在**的 `.json` / `.jsonc`；基名白名单不允许点号与路径分隔符。

`details` 字段是写流水线时最有用的东西 —— 它来自
`resource.get_node_data_parsed()`，返回**合并默认值之后**的节点定义：

```jsonc
{
  "等待游戏加载": {
    "ok": true,
    "merged": {
      "recognition": { "type": "DirectHit", "param": {} },
      "timeout": 120000,          // 自己写的
      "rate_limit": 500,           // 来自 default_pipeline.json
      "max_hit": 4294967295,       // 框架默认上限
      "pre_wait_freezes": { "time": 2000, "method": 5, ... },  // 数字被展开成对象
      "next": [ { "name": "通用弹窗处理", "jump_back": true }, ... ]  // 前缀被解析
    },
    "raw": "…原始 JSON 字符串…"
  }
}
```

### 配置与自检

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 当前配置 + 校验结果 |
| PUT | `/api/config` | 保存：校验 → 备份 → 原子写 → 回写内存 → 资源缓存失效 |
| POST | `/api/doctor` | 跑一遍自检（**不碰设备**），返回检查项数组 |
| GET | `/api/device` | MuMu 实例列表 + 当前设备状态 |
| POST | `/api/device/launch` | 拉起实例（`202` 后异步执行） |

保存配置时**路径不存在只给警告**：保存一份「指向还没装的模拟器」的配置是合法操作，
真正的体检交给 `doctor`（它用严格模式，路径不存在是致命错误）。

### 实时画面与手动操作

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/live/shot?instance=N` | 当前画面 PNG（带 `X-Image-Width/Height`）；无设备 `503` |
| POST | `/api/live/start` · `/api/live/stop` | 建立 / 释放常驻控制器 |
| POST | `/api/input/tap` | `{x, y, instance?}` |
| POST | `/api/input/swipe` | `{from:[x,y], to:[x,y], durationMs?, instance?}` |

**任务运行期间**手动操作与打开实时画面都返回 `409` —— 控制器操作全部走执行层的
串行队列，不会出现「手动点击和任务同时操作模拟器」。

### 调度

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/schedule` | 作业列表（含 `nextText` 下次触发）+ 历史 |
| POST | `/api/schedule/check` | 立即检查一次（调试用） |

调度器**只在 `ui` 命令里启动**，随界面进程生命周期。到点触发时如果已有任务在跑，
会记一条 `skipped` 而不是排队补跑（避免开机后堆积一串补跑）。
历史同时进内存（最近 50 条）与 `debug/schedule.jsonl`（超过 1MB 滚动为 `.1`）。

---

## 3. SSE 事件表

| 事件 | 载荷 | 什么时候来 |
|---|---|---|
| `snapshot` | 与 `/api/state` 同形 | 刚连上时补一帧，界面不用等轮询 |
| `state` | 运行状态快照 | 阶段变化、当前任务变化、结果登记 |
| `log` | `{ts, level, scope, message}` | 每一行日志（连上时会补发最近 800 条） |
| `node` | `{kind, phase, name}` | 流水线节点开始/失败（最近 300 条会补发） |
| `task` | `{entry, phase, uuid}` | Tasker 的任务级回调 |
| `device` | `{index, ready, live, address, detail}` | 设备/控制器状态变化（同值不重复推） |
| `schedule` | `{enabled, jobs, history}` | 调度触发、跳过、报错 |
| `run` | 运行记录 | 一次运行开始/结束 |

---

## 4. 改界面、加面板

### 4.1 控制台工程（`src/webui/`）

```text
src/webui/
  index.html          Vite 入口（只挂 #app）
  vite.config.mjs     root=本目录，产物 dist/（已 gitignore）
  src/main.js         挂载 Vue
  src/api.js          所有接口的封装：统一错误、401/409/422 的语义、X-Token
  src/store.js        SSE 长连接 + 状态快照 + 日志缓冲 + 提示条（reactive，不用 Pinia）
  src/App.vue         外壳：顶栏 + 左栏运行控制 + 右栏标签页
  src/components/     RunPanel / LivePanel / TasksPanel / PipelinePanel /
                      LogPanel / DevicePanel / SchedulePanel / ArtifactsPanel
```

| 命令 | 作用 |
|---|---|
| `npm run ui` | 起服务；`preui` 会按需构建控制台（已最新则跳过） |
| `npm run webui:build` | 强制重建 |
| `npm run webui:dev` | 前端热更新（5273），`/api` 代理到 `npm run ui` 的 8848 |
| `npm run webui:smoke` | 冒烟：不装浏览器，逐个面板 SSR 渲染，确认不会白屏 |

两条约定值得留意：

- **`src/webui/dist` 不入库**，但 `src/web.mjs` 会自动探测它：有就用控制台，
  没有就用内联页。所以「干净 clone → `npm run ui`」永远不会因为没构建而失败。
- **构建脚本把配置对象直接传给 Vite（`configFile: false`）**。走配置文件时
  Vite 会用自己的解析器加载它，那条路径不读 `resolve.preserveSymlinks`，
  在受限沙箱里会踩到 Windows 网络驱动器探测（同步 `net use`）抛 `EPERM`。
  详见 `src/webui/vite.config.mjs` 里 `preserveSymlinks` 的注释。

### 4.2 加一个面板

1. **先看数据够不够**：需要一个新数据，先看 `/api/state` 里有没有。有就直接用，
   别加接口。
2. **需要写操作**：在 `src/web.mjs` 的 `handle()` 里加分支。它是一串
   `if (req.method === 'GET' && route === '/api/xxx')`，**不引入路由框架**；
   带路径参数的（如 `/api/tasks/presets/:id`）用 `startsWith` + 自己切分，
   参考 `parsePresetPath()`。
3. **业务逻辑写进纯函数模块**（`task-config.mjs` / `pipeline-edit.mjs` /
   `schedule.mjs`），接口层只做「读→校验→写→回包」。
   这样逻辑能用 `node:test` 单测，不需要起 HTTP 服务。
4. **前端**：在 `src/webui/src/components/` 加一个 `.vue`，接口调用只写进
   `src/api.js`（组件里不直接 `fetch`），然后在 `App.vue` 的 `TABS` 里注册。
   顺手在 `tools/webui-smoke.mjs` 的 `PANELS` 里加一行，保证它至少能渲染。
5. **写操作务必**：先校验、再 `backupFile`、再 `writeFileAtomic`，
   并支持 `expectedMtime` 冲突检测。
6. **界面每加一个会改状态的操作**，思考「任务运行期间能不能做」——
   不能就返回 `409`，别让它和正在跑的任务抢设备。

## 5. 常见调试手法

```bash
# 只看接口，不带界面
node -e "fetch('http://127.0.0.1:8848/api/state').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,1)))"

# 看某次运行为什么是两条记录 / trigger 是什么
#   → 运行记录在 /api/state 的 runs[]，每条都有 trigger / presetName / status
#   → 日志里搜「运行开始」能看到每次 startRun 的来源

# 流水线为什么保存不了
curl -X POST -H "content-type: application/json" \
     -d '{"text":"<你的 JSON>"}' http://127.0.0.1:8848/api/pipelines/_common
#   → 返回 errors[] 会给出 JSON 路径（例如 A.next）

# 备份在哪
ls debug/pipeline-backups/   # 流水线
ls debug/config-backups/     # config.json 与 tasks.json（各保留最近 10 份）
```

`tools/lint-comments.mjs` 会检查一个很容易踩的坑：块注释里出现「星号 + 斜杠」
会**提前闭合注释**，导致后面几十行被当成代码解析，而报错行号会指到很远的地方。
