# game-auto-script

《无尽冬日》日常任务自动化 —— 基于 [MaaFramework](https://github.com/MaaXYZ/MaaFramework) 的
自包含 Node.js 应用，通过 MuMu 模拟器以**纯图像识别**方式驱动游戏，不使用任何内存修改或数据包篡改。

> **风险提示**：使用自动化脚本可能违反游戏用户协议。官方已多次专项打击脚本/同步器并大规模封禁账号。
> 请自行评估风险，建议**仅用单账号、低频运行、不要 7×24 挂机**，并先用可承受损失的小号验证。
> 本项目**不包含**任何反检测、设备指纹伪装或多账号同步器功能。

---

## 特点

- **自包含**：唯一运行时依赖是 `@maaxyz/maa-node`（内含 MaaFramework 全部原生库与 AgentBinary），
  不需要额外下载 300MB 的框架发行包，也不需要 MaaPiCli 或通用 GUI。
- **版本锁定**：`@maaxyz/maa-node` 与 MaaFramework 版本号一一对应，本项目锁定 `5.13.1`。
- **进程内自定义逻辑**：自定义识别/动作直接注册在 `Resource` 上、同进程回调 ——
  没有 agent socket、没有连接超时、没有跨进程版本错配。
- **MuMu 深度适配**：显式启用 `EmulatorExtras` 截图与输入。实测截图 **16ms**
  （未启用时回退 RawWithGzip 435ms），输入初始化 **3ms**。
- **识别以 OCR 为主**：文本识别与分辨率无关、可自证，且不需要预先裁剪模板。
- **失败可定位**：失败时保存失败截图 + 识别可视化 + 最后命中节点。
- **多开预留**：实例索引贯穿配置与控制器，改配置即可切换实例，无需改代码。

---

## 环境要求

| 项目 | 要求 | 说明 |
|---|---|---|
| Node.js | >= 20 | 开发验证于 v22.21.0 |
| MuMu 模拟器 | MuMu 12（`MuMuPlayer12 v5` 已验证） | 默认安装于 `D:/MuMu` |
| 游戏 | 《无尽冬日》`com.gof.china` 已安装并保持登录 | 登录态由你手工维持，本项目不保存账号密码 |
| 分辨率 | 固定分辨率，短边映射为 720 | 模板素材必须按同一基准裁剪 |

---

## 快速开始

```bash
npm install                  # 安装依赖（唯一依赖 maa-node）
npm run fetch-assets         # 下载 OCR 模型与 v5.13.1 官方文档
npm run doctor               # 环境自检：按需拉起模拟器、连 adb、截一张图
```

`doctor` 全绿（11/11）后即可运行：

```bash
npm run run                              # 按 config 里的任务列表执行
node src/index.mjs run --tasks 回到主界面  # 执行单个节点/模块
node src/index.mjs capture --count 5     # 采图供裁剪模板
```

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `node src/index.mjs doctor` | 环境自检：Node / 框架版本 / 配置 / OCR 模型 / 实例 / 控制器 / 截图 / 游戏包名 / 资源加载 |
| `node src/index.mjs run [--instance N] [--tasks a,b]` | 执行任务 |
| `node src/index.mjs list` | 列出实例、流水线文件与关键配置 |
| `node src/index.mjs capture [--count N] [--tag T]` | 批量截图到 `resource/image/_raw/<T>/` |
| `node src/index.mjs ui [--port N] [--open]` | 本地 Web 控制台：实时事件流（SSE）、任务启停、实时画面与手动操作、任务集编排、pipeline 编辑、定时 |
| `node src/index.mjs record <文件>` | 录制一次真实操作，供离线回放 |
| `node src/index.mjs replay <文件>` | 离线回放回归，不需要模拟器 |

`ui` 的额外开关：

| 开关 | 作用 |
|---|---|
| `--open` | 启动后自动打开浏览器 |
| `--no-schedule` | 本次不执行任何定时任务（只想开着界面时用） |
| `--allow-remote` | 允许局域网访问；**会自动生成写操作令牌并打印**，写接口需要请求头 `X-Token` |
| `--token VALUE` | 配合 `--allow-remote` 指定令牌（不给则自动生成） |

界面里的写操作还有 `Origin` 校验（防 DNS rebinding）：浏览器从非本机页面发起的
写请求一律 403。`GET` 不校验令牌，所以局域网里只读实时画面是被允许的。

### Web 控制台（Vue 3 + Vite）

`ui` 默认就把 `src/webui` 构建出来的控制台挂在 `/`。它由 Vite 打包成
`src/webui/dist`（不入库），**没有任何 CDN 依赖**；`npm run ui` 会先跑 `preui`
检查是否需要重新构建。

| 命令 | 作用 |
|---|---|
| `npm run ui` | 起服务（会自动构建控制台；已经是最新就跳过） |
| `npm run webui:build` | 强制重新构建控制台 |
| `npm run webui:dev` | 只起前端热更新（默认 5273），接口反向代理到 `npm run ui` 的 8848 |
| `npm run webui:smoke` | 冒烟：不装浏览器，把每个面板渲染一遍，确认不会白屏 |

没装前端依赖（`npm install --omit=dev`）或构建失败时，`ui` **不会**因此起不来：
`src/web.mjs` 里保留了一份内联单页兜底，启动日志会写明这次用的是哪一个。
控制台面板：运行控制 / 实时画面 / 任务集 / 流水线 / 日志 / 设备与配置 / 调度 / 产物。

### 诊断工具（`tools/`）

| 命令 | 作用 |
|---|---|
| `node tools/explore.mjs [--tap x,y] [--key N] [--swipe ...]` | **主要编写工具**：点击 → 等待 → 截图 → 像素统计 → OCR 读屏，并给出每条文字的中心坐标 |
| `node tools/probe.mjs [--count N]` | 连拍多张，报告画面是否有内容、是否在变化、上面有什么文字 |
| `node tools/ocr-dump.mjs <图片> [--roi x,y,w,h] [--expected 正则]` | 对已有图片跑 OCR |
| `node tools/fetch-assets.mjs [--ocr\|--docs]` | 重新拉取 OCR 模型 / 官方文档 |

`explore.mjs` 示例：

```bash
node tools/explore.mjs                              # 只看当前画面
node tools/explore.mjs --tap 649,1255               # 点「野外」再看
node tools/explore.mjs --tap "534,1256;360,700"     # 连续点两处
node tools/explore.mjs --roi 0,1225,720,55          # 只 OCR 底部导航
node tools/explore.mjs --key 4 --wait 1500          # 按返回键
```

退出码：`0` 成功 / `1` 任务失败 / `2` 环境或前置条件失败。

---

## 目录结构

```
src/
  index.mjs         CLI 入口（doctor / run / list / capture / ui / record / replay）
  config.mjs        配置加载、校验、实例→端口映射、运行时参数覆盖
  runtime.mjs       MaaFramework 全局选项初始化（CLI 与 tools 共用）
  device.mjs        MuMu 实例生命周期（MuMuManager）+ adb 健康检查
  mumu-detect.mjs   MuMu 安装位置自动定位（环境变量 / 注册表 / 常见目录 / PATH）
  controller.mjs    AdbController 创建、EmulatorExtras 掩码与 extras 注入、截图
  resource.mjs      资源包加载 + 自定义识别/动作注册
  runner.mjs        Tasker 编排、事件日志、失败留证、单步超时
  runner-web.mjs    Web 执行层：任务集/单节点执行、实时画面、手动操作、串行队列
  task-config.mjs   任务集读写与纯逻辑（校验/排序/开关/解析）
  pipeline-edit.mjs 流水线校验与安全写入（引用完整性、目录穿越防护、备份）
  schedule.mjs      自带 5 段 cron 解析 + 调度器
  web.mjs           本地 Web 服务：REST + SSE + 控制台静态资源（无构建产物时兜底内联页）
  replay.mjs        离线录制 / 回放
  webui/            Vue 3 控制台（阶段 3）：Vite 工程 + 组件，产物 dist/ 不入库
    index.html        Vite 入口
    vite.config.mjs   构建配置（root 即本目录，产物 dist/）
    src/App.vue       外壳：顶栏 + 运行控制 + 标签页面板
    src/api.js        全部 HTTP 接口封装（统一错误与 X-Token）
    src/store.js      SSE 长连接 + 状态快照 + 日志缓冲 + 提示条
    src/components/   RunPanel / LivePanel / TasksPanel / PipelinePanel /
                      LogPanel / DevicePanel / SchedulePanel / ArtifactsPanel
  custom/
    reco.mjs        自定义识别：wjdr_read_count / wjdr_find_march_slot / wjdr_visible
    action.mjs      自定义动作：wjdr_pick_upgrade_target / wjdr_ensure_home /
                    wjdr_dismiss_popup / wjdr_tap_center
  util/
    detail.mjs      识别结果读取（RecoDetail 的两种形态）
    exec.mjs        外部命令封装（管道被禁时自动降级）
    fsx.mjs         原子写 + 备份轮转
    image.mjs       图片尺寸解析与落盘
    png.mjs         零依赖 PNG 解码 / 像素统计 / 差异比较
    log.mjs         分级日志
resource/
  default_pipeline.json   全局默认字段（Bundle 根目录，与 pipeline/ 同级）
  pipeline/               任务流水线 JSON
  image/                  模板素材（720 短边归一后裁剪；当前为空，走 OCR）
  model/ocr/              OCR 模型（由 fetch-assets 下载，不入库）
config/config.json        设备与运行参数
config/tasks.json         任务集（编排 / 顺序 / 开关 / 单步超时 / 定时；不入库）
tools/                    诊断与编写工具（webui-build / webui-dev / webui-smoke 见上）
docs/WEBUI.md             Web 接口契约与扩展指南
docs/reference/           拉取的 v5.13.1 官方文档（不入库）
debug/                    日志、失败截图、可视化、录制、自动备份、调度历史（不入库）
dist/                     打包产物（由 build-portable.mjs 生成，不入库）
test/                     单元测试（npm test）
```

---

## 配置说明

```jsonc
{
  "mumu": {
    // 安装位置**留空即自动检测**，见下面「MuMu 装在哪不用你填」。
    // 只有想固定下来时才写这三条：
    // "path": "D:/MuMu",
    // "manager": "D:/MuMu/nx_main/MuMuManager.exe",
    // "adb": "D:/MuMu/nx_main/adb.exe",
    "basePort": 16384,     // 实例 0 的 adb 端口
    "portStep": 32         // 每多开一个实例端口递增 32
  },
  "game": { "package": "com.gof.china" },
  "runtime": {
    "shortSide": 720,          // 截图短边归一，必须与模板裁剪基准一致
    "launchTimeoutMs": 90000,  // 等待实例启动的上限
    "taskTimeoutMs": 600000,   // 单任务上限
    "saveDraws": false,        // 是否保存全部识别可视化
    "logLevel": "info"
  },
  "instances": [
    { "index": 0, "enabled": true, "tasks": ["99_一键日常"] }
  ]
}
```

**多开**：在 `instances` 里追加 `{ "index": 1, "enabled": true, "tasks": [...] }`，
端口自动算成 `16384 + 32 × 1 = 16416`，无需改代码。

### MuMu 装在哪不用你填

`mumu.path` / `manager` / `adb` 留空时会在启动阶段**自动定位**（`src/mumu-detect.mjs`），
按下面的顺序找，命中即止：

| 顺序 | 来源 |
|---|---|
| 1 | 环境变量 `MUMU_PATH`（安装目录）、`MUMU_MANAGER`、`MUMU_ADB`（具体文件） |
| 2 | 注册表：卸载项里的 `InstallLocation` / `UninstallString`，以及 `SOFTWARE\Netease` 下的路径值 |
| 3 | 常见安装目录：各盘符的盘根、`Program Files[\Netease]`、`Games`、`%LOCALAPPDATA%`、`%APPDATA%`、`%ProgramData%` 下名字含 mumu 的目录 |
| 4 | `where MuMuManager.exe`（装在 PATH 上的少数情况） |

MuMu 6 与 MuMu Player 12 的目录结构不一样（`emulator\nemu\vmonitor\bin` vs `nx_main`），
两套都认；adb 优先用 MuMu 自带的那个，找不到就交给 PATH 上的 `adb`。

几个要点：

- **显式配置永远优先**。你在 `config/config.json` 里写了哪条，就用哪条，绝不被覆盖；
  写了 `path` 或 `manager` 中的任意一条后，也**不会**再去别处找另一套拼进来。
- **自动检测的路径不会写回文件**。界面里点「保存」时，凡是自动填进去、你也没改过的
  路径都会被剔除 —— 否则点一次保存就把本机路径固化进入库的 `config.json` 了。
  想固定下来，就手动在 `config/config.json` 里写（或设置上面的环境变量）。
- 想确认它到底找到了哪一套：`npm run doctor` 的「MuMu 位置」一行会写明**来源**，
  `npm run list` 与界面「设备与配置」面板也会显示。
- 找不到时**不会**挡住启动（界面、`list`、`run --dry-run` 都不需要模拟器），
  只给一条警告；真正需要模拟器的命令会明确报错。

---

## 流水线编写要点

协议见 `docs/reference/3.1-任务流水线协议.md`（v5.13.1）。以下几条是**踩过坑的**：

1. **识别优先用 OCR**。用 `tools/explore.mjs` 读出文字与坐标，据此写 `expected` + `roi`，
   不靠猜坐标、也不需要先裁模板。只有纯图标控件才需要模板。
2. **`timeout` 属于「当前节点 `next` 列表的识别等待时间」**。
   想让某节点多等一会儿，要改的是**上一个节点**的 `timeout`。
   例如「等待游戏加载」应写成：

   ```jsonc
   "等待游戏加载": {
     "recognition": { "type": "DirectHit", "param": {} },
     "action": { "type": "DoNothing", "param": {} },
     "timeout": 120000,                     // 在 120s 内反复尝试识别 next
     "next": ["[JumpBack]通用弹窗处理", "确认主界面"],
     "on_error": ["回到主界面"]              // 超时后的兜底
   }
   ```

3. **弹窗兜底用 `[JumpBack]`，不是 `focus`**。`focus` 只用于产生回调消息。
   把 `"[JumpBack]通用弹窗处理"` 放在 `next` 首位，命中后处理完会自动回到父节点继续。
4. **循环节点一律设 `max_hit`**，避免死循环。
5. **每个模块末尾 `next: ["回到主界面"]`**，保证模块之间互不污染。
6. **不要用 `on_error` 指回自己**构成无限重试；把等待放在上一个节点的 `timeout` 里。

### 已实测的城市主界面坐标（720×1280）

| 元素 | box | 中心 |
|---|---|---|
| 探险 / 英雄 / 背包 | `[43,1241,53,29]` `[161,1237,54,33]` `[279,1242,49,27]` | (70,1256) (188,1254) (303,1257) |
| 商店 / 联盟 / 野外 | `[395,1242,48,27]` `[509,1242,49,27]` `[619,1237,59,36]` | (420,1256) (534,1256) (649,1255) |
| 顶部 兵力 / 战力 | `[280,8,72,28]` `[129,54,135,28]` | (316,22) (197,68) |
| 资源 / 温度 | `[431,10,87,24]` `[590,10,73,24]` `[328,57,73,37]` | (475,22) (627,22) (364,75) |
| 左侧任务追踪 | `[76,1037,303,28]` | (229,1051) |

底部导航整条带子的 roi 用 `[0, 1225, 720, 55]` 即可稳定命中「回到主界面」。

---

## 已知 API 陷阱（v5.13.1）

这几个都实际踩过，记录下来避免重犯：

1. **`post_recognition` / `post_task` 的 `job.get()` 返回的是 `TaskDetail`，不是 `RecoDetail`**。
   `TaskDetail` 形如 `{ entry, nodes: NodeId[], status }`。直读 `task.detail` 恒为 `undefined`，
   表现为「明明识别到了却读不出结果」。正确路径：

   ```js
   const task = await job.get();                       // TaskDetail
   const node = tasker.node_detail(task.nodes[0]);     // NodeDetail
   const reco = node.reco;                             // RecoDetail
   ```

   已封装为 `src/util/detail.mjs` 的 `recognizeWithTasker` / `recoObject` / `bestOf`。

2. **自定义动作的 `self` 里没有 `image`**（只有自定义**识别**才有）。
   误用会得到 `undefined`，回调瞬间抛错并被框架吞成 `false`，
   表现为「动作 3ms 就返回失败」。动作内需自行截图（见 `grabImage`）。

3. **设备扫描返回的 extras 配置是 `"{}"`，不是 `nullish`**，
   所以用 `??` 兜底根本不会触发 —— MuMu 加速会静默失效。
   必须无条件注入 `extras.mumu.path`（`buildExtrasConfig`）。注意 `"[]"` 也会被
   `JSON.parse` 成数组，而数组在 `JSON.stringify` 时会丢掉后加的属性。

4. **上下文消息名是 `PipelineNode.Starting` 这类「类别.阶段」形式**，
   不是裸 `RecognitionNode`。按裸名比较会永远匹配不上，
   导致失败时「最后节点」恒为未知。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `MuMuManager ... launch` 返回 `errcode: 0` 但实例始终不启动 | **沙箱限制**：MuMu 启动 VM 需要写工作区之外的目录。在受限沙箱下会「静默失败」。请在沙箱外启动模拟器，或用完全访问权限运行 |
| `spawn EPERM` | 受限环境禁止进程使用命名管道。`src/util/exec.mjs` 会自动降级为文件描述符模式，无需处理 |
| `node --test test/` 报 `spawn EPERM` | Node 自带 test runner 会为每个文件 spawn 子进程。本项目改用 `node test/run.mjs` 同进程运行 |
| `cannot connect to 127.0.0.1:16384 ... 10061` | 模拟器未运行或被关闭。`doctor` 会自动拉起；运行期出现说明实例中途挂了 |
| `MuMu 位置` 报「未找到 MuMuManager.exe」 | 自动检测没命中（装在很偏的目录、绿色版、或注册表里没有）。`MUMU_PATH=你的安装目录 npm run doctor` 试一次，或直接在 `config/config.json` 里显式写 `mumu.manager` |
| `MuMu 位置` 找错了另一套 MuMu | 装了多个版本。显式写 `mumu.manager` / `mumu.path` 固定下来即可（显式值优先于自动检测） |
| `Failed to load det or rec` | OCR 模型缺失，运行 `npm run fetch-assets` |
| 识别一直不命中 | 截图短边与模板基准不一致（`doctor` 会提示）；或游戏更新换皮，需改 `expected` 或重裁模板 |
| `npm install` 报 `EPERM ... npm-cache` | 环境变量 `npm_config_cache` 指向了不可写目录，改用 `npm install --cache ./.npm-cache` |
| 排障时框架日志是空的 | 忘了设 `maa.Global.log_dir`。CLI 与 tools 都应调用 `initRuntime()` |

### 失败产物

`debug/on_error/` 下会同时出现两类文件，各有用途：

- `2026.09.22-16.49.13.492_<节点名>.png` —— MaaFramework 在**失败瞬间**保存（权威）
- `<时间戳>_<任务名>.png` —— 本项目在失败后保存，按**任务名**命名，便于检索

`debug/draws/` 为识别可视化；`debug/run-*.log` 为完整运行日志。

---

## 打包与分发

给不想装 Node、也不想碰命令行的使用者（例如朋友）打包成一个自包含目录：

```bash
node tools/build-portable.mjs                  # 默认：dist/game-auto-script-<版本>/
node tools/build-portable.mjs --slim           # 去掉 test/ 与开发用工具
node tools/build-portable.mjs --with-node      # 连 node.exe 一起带上（对方无需装 Node）
node tools/build-portable.mjs --with-node --zip  # 再打一个 zip
node tools/build-portable.mjs --out D:/somewhere # 指定输出目录
```

打出来的目录里有五个中文启动器：`环境自检.cmd`、`执行日常.cmd`、`启动界面.cmd`、
`录制回放自检.cmd`、`离线回放自检.cmd`。

打包时会先把 Vue 控制台构建出来再拷贝（启动器直接跑 `node src\index.mjs ui`，
不经过 npm 的 `preui`，所以包里有什么 `dist` 就发什么），并校验包里的
`index.html` 及其引用的资源都在；没装前端依赖时只告警，包照出、界面退回内联页。

> 打包产物 `dist/` **不入库**（含 80MB 的 `node.exe`，会被 GitHub 拒绝），已加进 `.gitignore`。
> 打包脚本末尾会自动实跑一次产物做校验，缺原生绑定或 DLL 会直接失败。

---

## 开发

```bash
npm test          # 单元测试（同进程运行，适配受限环境）
npm run doctor    # 改动后先跑自检，确认链路未坏
```

编写新任务模块的流程：

1. `node tools/explore.mjs` 走到目标界面，读出文字与中心坐标；
2. 写 `resource/pipeline/NN_模块.json`，`roi` 取实测坐标外扩约 10px 并对齐偶数；
3. `node src/index.mjs run --tasks NN_模块` 验证；
4. 失败就看 `debug/on_error/` 的截图与日志里的「最后节点」，修正后重跑；
5. **再跑一次确认可重复**（幂等）。

---

## 路线图

- [x] **P0** 骨架、依赖锁定、OCR 模型与文档拉取、实例生命周期、控制器、CLI `doctor`（11/11）
- [x] **P1** 资源底座（`default_pipeline.json`、`_common.json`）、`capture`、`probe`/`explore`/`ocr-dump`
- [x] **P2** 自定义识别/动作实现，`wjdr_ensure_home` 已实测通过
- [ ] **P3** 九个任务模块流水线（联盟帮助 / 资源采集 / 情报任务 / 竞技场 / 探险打怪 /
      建筑科技 / 士兵训练 / 签到礼包码 / 限时活动）
      —— 联盟日常已完成，其余待编写
- [x] **P4** 引擎与 CLI 打磨（模块自动发现、生命周期、`--retry` / `--dry-run`、配置校验）
- [x] **P5** 本地 Web UI（`ui`，SSE 实时事件 + 并发守卫）
- [x] **P6** 离线录制/回放（`record` / `replay` + 回归自检）
- [x] **P7** 打包与分发（`tools/build-portable.mjs`、启动器 `.cmd`、zip）
- [x] **P8** Web 控制台（Vue 3 + Vite：任务集编排、pipeline 编辑、实时画面与手动操作、日志、调度、产物）
- [ ] **P9** 九个任务模块全部完成后：多开参数化验证 + 完整离线回归
