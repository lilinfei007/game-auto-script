# 使用指南：跑起来 + 写 pipeline

本文讲**这个项目怎么用**：怎么跑、pipeline 怎么写、用哪些工具写、踩过的坑在哪。
MaaFramework 的协议细节看 `docs/reference/3.1-任务流水线协议.md`
（v5.13.1 官方文档，`npm run fetch-assets` 下载，不入库）。

- 想了解项目结构与设计取舍 → `README.md`
- 想了解 Web 控制台的接口与前端结构 → `docs/WEBUI.md`

---

## 1. 环境要求

| 项目 | 要求 | 说明 |
|---|---|---|
| Node.js | **>= 20** | 开发验证于 v22.21.0 |
| MuMu 模拟器 | MuMu 12（MuMuPlayer12 v5 已验证） | **装在哪个盘不用配**，启动时自动检测（环境变量 → 注册表 → 常见目录 → PATH） |
| 游戏 | 《无尽冬日》`com.gof.china` 已安装并保持登录 | 登录态由使用者手工维持，本项目不保存账号密码 |
| 分辨率 | 固定分辨率，短边映射为 720 | 模板素材必须按同一基准裁剪 |

MuMu 路径的自动检测与「怎么固定下来」见 `README.md` 的「MuMu 装在哪不用你填」。

---

## 2. 首次启动

```bash
npm install           # 运行时唯一依赖是 maa-node；devDependencies 只有控制台用的 vite/vue
npm run fetch-assets  # 下载 OCR 模型 + v5.13.1 官方文档（不入库，必须跑一次）
npm run doctor        # 环境自检：按需拉起模拟器、连 adb、截一张图、验游戏包名
```

`doctor` 全绿（**13/13**）即可运行。它会逐项打勾，哪一项 ✘ 就是哪一环的问题：

```
✔ Node 版本        ✔ MaaFramework 版本   ✔ 配置文件        ✔ MuMu 位置
✔ OCR 模型         ✔ 流水线解析          ✔ 可执行模块      ✔ MuMu 实例
✔ 实例就绪         ✔ 控制器              ✔ 截图            ✔ 游戏包名
✔ 资源加载
```

`MuMu 位置` 一行会写明路径是**自动检测**来的还是配置文件里写的；路径不对时一眼能看出是「没找到」还是「找错了」。

---

## 3. 日常命令

| 命令 | 作用 |
|---|---|
| `npm run doctor` | 环境自检（能定位绝大多数「跑不起来」） |
| `npm run run` | 执行任务 |
| `npm run list` | 列出 MuMu 位置、实例、流水线文件与入口节点 |
| `npm run ui` | 本地 Web 控制台（日常推荐） |
| `npm run capture` | 批量截图到 `resource/image/_raw/`，供裁剪模板 |
| `npm run record` | 录制一段真实操作 |
| `npm run replay` | 离线回放录制（**不需要模拟器**） |
| `npm test` | 全部单测，同进程运行 |

### 3.1 `run` 的参数

```bash
node src/index.mjs run --tasks 10_联盟日常     # 指定任务（节点名或流水线文件名都行）
node src/index.mjs run --all --retry 1        # 忽略配置跑全部模块；失败重试 1 次（重试前先回主界面）
node src/index.mjs run --dry-run              # 只解析入口 + 加载资源，不连设备（改完 JSON 先跑这个）
node src/index.mjs run --instance 1           # 指定多开实例
node src/index.mjs run --verbose              # debug 日志
```

其它常用：`capture --count N --interval MS --tag T --ocr`、
`ui --port N --open --allow-remote --token V --no-schedule`、
`replay --record <文件>`、`doctor --deep`。完整列表见 `node src/index.mjs help`。

### 3.2 默认任务从哪来（优先级从高到低）

1. `--tasks` 指定的任务
2. `config/config.json` 里 `instances[].tasks`（非空且都能解析时）
3. **自动发现**：按文件名顺序执行 `resource/pipeline/` 下所有模块（跳过 `_` 开头的共享文件）

### 3.3 退出码

| 码 | 含义 |
|---|---|
| 0 | 全部成功 |
| 1 | 任务失败 |
| 2 | 环境或前置条件失败 |
| 130 | 用户中断（Ctrl+C） |

---

## 4. Web 控制台

`npm run ui` 默认挂在 `http://127.0.0.1:8848/`（`preui` 会先构建 `src/webui/dist`）。
八个面板：

| 面板 | 用途 |
|---|---|
| 运行控制 | 勾任务集、跑/停、看进度与最近运行（常驻左栏） |
| 实时画面 | 定时刷新的截图，**可直接在上面点/滑**操作设备；单节点试跑 |
| 任务集 | 编排顺序、开关、单步超时、定时（cron） |
| 流水线 | 节点索引 + 引用关系 + 孤儿节点；在线改 JSON 并校验 |
| 日志 | 事件流，按节点/任务过滤，自动滚到底 |
| 设备与配置 | MuMu 实例操作、改 `config.json`、跑 doctor |
| 调度 | 定时任务与下次触发、执行历史 |
| 产物 | 失败截图与识别可视化 |

`--allow-remote` 允许局域网访问，会自动生成写操作令牌并打印（写接口需要 `X-Token`）；
写操作还有 `Origin` 校验（防 DNS rebinding），`GET` 不需要令牌。

---

## 5. 写 pipeline

### 5.1 文件放哪、怎么命名

```
resource/pipeline/
  _common.json        共享节点（_ 开头 = 不是模块，不参与自动执行，但任何模块都能引用）
  00_启动游戏.json     数字前缀 = 自动发现的执行顺序（按文件名字符串排序）
  10_联盟日常.json
```

三条规则：

1. **模块的入口 = 文件里的第一个节点**（不是按名字匹配）。所以入口节点写在最上面。
2. **`_` 开头的文件不是模块**，但里面的节点全局可见，用名字就能 `next` 过去（如 `回到主界面`）。
3. 后缀 `.json` / `.jsonc` 都收；`.jsonc` 允许写 `//` 注释，本项目会先剥注释再解析。

### 5.2 节点字段

```jsonc
"联盟日常_点互助": {
  "recognition": { "type": "OCR", "param": { "expected": "^互助$", "roi": [0, 0, 0, 0] } },
  "action":      { "type": "Click", "param": {} },
  "pre_wait_freezes": 800,     // 动作前等画面稳定（默认 0）
  "post_delay": 500,           // 动作后固定等待（默认 200）
  "timeout": 5000,             // ★ 本节点 next 列表的识别超时（默认 20000，-1 = 无限）
  "max_hit": 5,                // 本节点最多命中几次（默认无限，循环必须设）
  "next": ["[JumpBack]通用弹窗处理", "联盟日常_全部帮助"],
  "on_error": ["回到主界面"]    // next 超时或动作失败后的兜底
}
```

单次动作的执行顺序是：
`pre_wait_freezes` → `pre_delay`（默认 200）→ **action** → `post_wait_freezes` → `post_delay`（默认 200）。

其它可用字段：`enabled`（临时停用）、`inverse`（反转识别结果）、
`anchor` / `[Anchor]`（锚点）、`repeat` / `repeat_delay` / `repeat_wait_freezes`（v5.3）。

### 5.3 识别类型

| 类型 | 什么时候用 |
|---|---|
| `OCR` | **首选**。`expected` 写正则，`roi` 圈定区域。不用裁模板、不怕换皮 |
| `DirectHit` | 无条件命中（做「等待」「占位」「只执行动作」的节点） |
| `TemplateMatch` | 纯图标控件（没有文字可读时） |
| `FeatureMatch` / `ColorMatch` | 特征点匹配 / 颜色匹配，特殊场景 |
| `NeuralNetworkClassify` / `NeuralNetworkDetect` | 自训练模型，本项目未使用 |
| `Custom` | 用本项目注册的自定义识别器（见 5.5） |

### 5.4 动作类型

`DoNothing` | `Click` | `LongPress` | `Swipe` | `MultiSwipe` | `Scroll` |
`ClickKey` | `LongPressKey` | `InputText` | `StartApp` | `StopApp` | `StopTask` |
`Command` | `Shell` | `Screencap` | `Custom`

本项目实际用到的是 `DoNothing` / `Click` / `ClickKey`（`4` = 返回键）/ `StartApp` / `Custom`。

### 5.5 本项目自带的自定义识别 / 动作

识别器（`src/custom/reco.mjs`）：

| 名字 | 参数 | 用途 |
|---|---|---|
| `wjdr_read_count` | `roi, expected, pattern, fallback` | 读一个数字（剩余次数 / 资源量 / 费用） |
| `wjdr_find_march_slot` | `template, roi, threshold, pick` | 在区域内找可用目标（如空闲行军队列） |
| `wjdr_visible` | `templates[], ocr[], roi, threshold` | 多个候选中返回第一个命中的框 |

动作（`src/custom/action.mjs`）：

| 名字 | 参数 | 用途 |
|---|---|---|
| `wjdr_ensure_home` | `templates, ocr, roi, maxAttempts, intervalMs` | **界面守卫**：反复操作直到命中「主界面标记」 |
| `wjdr_dismiss_popup` | `templates, roi, threshold, keycode` | 关闭意外弹窗 |
| `wjdr_tap_center` | `offsetX, offsetY` | 点击识别结果框中心（把「识别 → 点击」合成一步） |
| `wjdr_pick_upgrade_target` | 候选列表 | 在候选里挑「最便宜 / 最省时」的一项并点击 |

调用方式：

```jsonc
"回到主界面": {
  "recognition": { "type": "DirectHit", "param": {} },
  "action": { "type": "Custom", "param": {
    "custom_action": "wjdr_ensure_home",
    "custom_action_param": { "maxAttempts": 6 }
  } },
  "next": []
}
```

它们是**进程内注册**的（不走 AgentServer socket），所以没有连接超时、没有跨进程版本错配。

### 5.6 例子：`00_启动游戏.json` 逐段看

```jsonc
"启动游戏"    // StartApp 启动 com.gof.china；next 首位挂弹窗兜底，然后等加载
"等待游戏加载" // DoNothing + pre_wait_freezes 2000 + timeout 120000，超时 on_error 回主界面
"确认主界面"  // OCR 匹配 ^野外$（roi 只看底部导航），next 为空 = 模块结束
```

每一步的 `next` 首位都是 `"[JumpBack]通用弹窗处理"`：随机弹窗不会打断流程，
处理完会自动回到父节点、从 `next` 列表开头重新识别。

### 5.7 六条硬规矩（都踩过）

1. **`timeout` 属于「本节点 `next` 列表的识别等待时间」**。想让某步多等，要改的是**上一个节点**的 `timeout`。
2. **弹窗兜底用 `"[JumpBack]通用弹窗处理"` 放 `next` 首位**，不要用 `focus`（`focus` 只产生回调消息）。
3. **循环节点必须设 `max_hit`**，否则死循环。
4. **每个模块末尾 `next: ["回到主界面"]`**，保证模块之间互不污染。
5. **别用 `on_error` 指回自己**造无限重试；把等待放进上一个节点的 `timeout` 里。
6. **`[JumpBack]` 在错误处理路径（`on_error`）下不触发**，别指望它兜住异常分支。

---

## 6. 用什么工具写

### 6.1 `tools/explore.mjs`（主力）

**pipeline 里的每个 `roi` 和 `expected` 都应当由它的实测输出推导，不要靠猜。**
一条命令完成「点一下 → 等一下 → 截图 → 像素统计 → OCR 读屏」，并给出每条文字的中心坐标。

```bash
node tools/explore.mjs                                   # 只看当前画面 + 读出所有文字
node tools/explore.mjs --tap 649,1255                    # 点「野外」，再看新画面
node tools/explore.mjs --tap "534,1256;360,700"          # 连续点两处
node tools/explore.mjs --roi 0,1225,720,55               # 只 OCR 底部导航（用来圈 roi）
node tools/explore.mjs --key 4 --wait 1500               # 按返回键
node tools/explore.mjs --scale 3 --roi 600,250,120,200   # 放大 3 倍读小字
node tools/explore.mjs --repeat 3 --tap 640,1100         # 重复点（看列表刷新）
```

典型闭环：**`explore` 点进去 → 读出目标文字 → 把坐标范围抄成 `roi`、文字抄成 `expected` → 写进 JSON**。

### 6.2 其它工具

| 工具 | 什么时候用 |
|---|---|
| `node tools/probe.mjs --count 5 --interval 2000` | 连拍多张，判断「黑屏？卡加载？画面稳不稳」→ 决定 `pre_wait_freezes` 给多少 |
| `node tools/ocr-dump.mjs <图片> [--roi x,y,w,h] [--expected 正则]` | 对已有截图跑 OCR（手上有图、不想连设备时） |
| `node src/index.mjs capture --count 5 --ocr` | 批量采图，要裁模板时用 |
| `node tools/lint-comments.mjs` | 排查「块注释里写了 `*/` 导致注释提前闭合」这类隐蔽错误 |
| `node tools/build-portable.mjs [--slim] [--with-node] [--zip]` | 打自包含目录（含中文启动器），给不装 Node 的人用 |
| 控制台「流水线」面板 | 在线改 JSON 并校验、看节点索引 / 引用关系 / 孤儿节点 |
| 控制台「实时画面」 | 直接点 / 滑操作设备，边点边看，比命令行直观 |

### 6.3 调试产物

| 位置 | 内容 |
|---|---|
| `debug/on_error/` | 失败瞬间的截图：`<时间戳>_<节点名>.png`（框架存的，权威）+ 带任务名的副本 |
| `debug/draws/` | 识别可视化——框出它到底「看到」了什么（`runtime.saveDraws: true` 开启） |
| `debug/run-*.log` | 每次运行的完整日志，搜「最后节点」定位卡在哪 |
| `debug/recording/` | `record` 生成的录制文件，供 `replay` 离线回放 |

---

## 7. 写一个新模块的流程

1. `npm run doctor` 确认环境全绿（不绿先修环境，别急着写 JSON）
2. 手动把游戏开到目标界面，`node tools/explore.mjs` 看清当前有什么文字、坐标多少
3. 逐步 `--tap` 走一遍完整流程，每一步记下文字 + 坐标 → 这就是节点序列
4. 新建 `resource/pipeline/20_xxx.json`，**第一个节点就是入口**，节点名统一加模块前缀（如 `资源采集_进入野外`）
5. 每步 `next` 首位挂 `"[JumpBack]通用弹窗处理"`；循环节点设 `max_hit`；末尾 `next: ["回到主界面"]`
6. `node src/index.mjs run --dry-run` 验证 JSON 能解析、入口能找到
7. `node src/index.mjs run --tasks 20_xxx`（或用控制台的「单节点试跑」逐节点验），盯着实时画面
8. 失败就看 `debug/on_error/` 的截图改 `roi` / `expected`，**再重跑一遍确认可重复**

第 7 步用控制台的「单节点试跑」特别省时间：不必从头跑整个模块，挑一个节点直接执行，几秒看结果。

---

## 8. 常见问题速查

| 现象 | 处理 |
|---|---|
| `doctor` 报「MuMu 位置」找不到 | 自动检测没命中。`MUMU_PATH=你的安装目录 npm run doctor` 试一次，或在 `config/config.json` 里显式写 `mumu.manager` |
| `doctor` 报「MuMu 位置」找错了另一套 | 装了多个版本。显式写 `mumu.manager` 固定下来（显式值优先于自动检测） |
| `MuMuManager ... launch` 返回 `errcode: 0` 但实例不启动 | 受限沙箱下 MuMu 启动 VM 会静默失败，请在沙箱外启动模拟器 |
| `cannot connect to 127.0.0.1:16384` | 模拟器未运行或被关闭；`doctor` 会自动拉起 |
| `Failed to load det or rec` | OCR 模型缺失，跑 `npm run fetch-assets` |
| 识别一直不命中 | 截图短边与模板基准不一致（`doctor` 会提示）；或游戏更新换皮，需改 `expected` / 重裁模板 |
| 节点「明明识别到了却读不出结果」 | `post_task` 的 `job.get()` 返回 `TaskDetail` 而非 `RecoDetail`，见 README「已知 API 陷阱」 |
| 自定义动作 3ms 就返回失败 | 自定义**动作**的 `self` 里没有 `image`，需自行截图（`grabImage`） |
| `npm install` 报 `EPERM ... npm-cache` | 改用 `npm install --cache ./.npm-cache` |
| 排障时框架日志是空的 | 忘了设 `maa.Global.log_dir`，CLI 与 tools 都应调用 `initRuntime()` |

---

## 相关文档

| 文档 | 内容 |
|---|---|
| `README.md` | 项目结构、设计取舍、API 陷阱、打包分发 |
| `docs/WEBUI.md` | Web 控制台的接口契约与前端结构 |
| `docs/reference/3.1-任务流水线协议.md` | MaaFramework v5.13.1 官方流水线协议（`fetch-assets` 下载） |
| `docs/reference/NodeJS__J1.2-自定义识别_操作.md` | 官方自定义识别 / 动作接口 |
| `docs/reference/1.1-快速开始.md`、`2.1-集成文档.md` | 官方集成文档（NodeJS 绑定） |
