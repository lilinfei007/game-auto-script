/**
 * CLI 参数解析与「要跑什么」的决策。
 *
 * 从 index.mjs 抽出来是为了可测：index.mjs 一被 import 就会执行 main()，
 * 没法在测试里单独调用这些纯逻辑。
 */
import { discoverModules, resolveEntry } from './resource.mjs';

/** 已知选项：拼错时报错，而不是静默忽略。 */
export const KNOWN_FLAGS = new Set([
  // 通用
  'instance', 'verbose', 'help', 'version',
  // run
  'tasks', 'all', 'retry', 'dry-run',
  // doctor
  'deep',
  // capture
  'count', 'interval', 'tag', 'out', 'ocr',
  // ui
  'port', 'host', 'allow-remote', 'open', 'token', 'no-schedule',
  // record / replay
  'record', 'no-device',
  // 打包
  'slim', 'with-node', 'zip', 'no-tests',
]);

export const USAGE = `
《无尽冬日》日常自动化 —— 基于 MaaFramework 的本地脚本

用法:
  node src/index.mjs <命令> [选项]

命令:
  doctor            环境自检（不带命令时的默认动作）
  run               执行任务
  list              列出实例、流水线模块与关键配置
  capture           批量截图，供裁剪模板
  ui                启动本地网页界面
  record            录制一段操作，供离线回放
  replay            离线回放录制（不需要模拟器）
  help              显示本帮助

选项:
  --instance N      指定实例索引（默认取配置里第一个启用的）
  --tasks a,b       指定任务（节点名或流水线文件名，如 10_联盟日常）
  --all             忽略配置，按文件名顺序执行所有模块
  --retry N         失败后重试次数，每次重试前先回到主界面（默认 0）
  --dry-run         只解析入口并加载资源，不连接设备
  --deep            doctor 额外实跑一个节点
  --count N         capture 张数（默认 1）
  --interval MS     capture 间隔毫秒（默认 1500）
  --tag NAME        capture 子目录名（默认时间戳）
  --out PATH        capture 输出目录 / record 录制文件路径
  --ocr             capture 时顺带打印识别到的文字
  --record FILE     replay 要回放的录制文件（record 生成）
  --port N          ui 监听端口（默认 8848）
  --allow-remote    ui 允许非本机访问（默认只监听 127.0.0.1）
  --token VALUE     配合 --allow-remote：写操作需要的 X-Token（默认自动生成并打印）
  --no-schedule     ui 启动后不执行任何定时任务（只想开着界面时用）
  --open            ui 启动后自动打开浏览器
  --verbose         打开 debug 日志
  -h, --help        显示本帮助
  -v, --version     显示版本

默认任务来源（优先级从高到低）:
  1. --tasks 指定的任务
  2. config/config.json 里 instances[].tasks（非空且都能解析时）
  3. 自动发现：按文件名顺序执行 resource/pipeline 下所有模块（跳过 _ 开头的共享文件）

退出码:
  0    全部成功
  1    任务失败
  2    环境或前置条件失败
  130  用户中断（Ctrl+C）

示例:
  npm run doctor
  node src/index.mjs run --tasks 10_联盟日常
  node src/index.mjs run --all --retry 1
  node src/index.mjs run --dry-run
  node src/index.mjs ui --port 8848
  node src/index.mjs record --tasks 10_联盟日常
  node src/index.mjs replay --record debug/recording/xxx.rec --tasks 10_联盟日常
`.trim();

/**
 * 解析 argv。未知选项直接抛错（静默忽略会让人以为写对了）。
 * 值里允许出现单个 `-`，但不允许 `--`（避免把下一个选项当成值）。
 */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '-v') {
      args.version = true;
      continue;
    }
    if (a.startsWith('-') && !a.startsWith('--')) {
      throw new Error(`未知的短选项：${a}（只支持 -h / -v）`);
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!KNOWN_FLAGS.has(key)) {
        throw new Error(`未知选项：--${key}（用 help 查看可用选项）`);
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
      continue;
    }
    args._.push(a);
  }
  return args;
}

export function parseInstanceArg(args) {
  if (args.instance === undefined) return undefined;
  const n = Number(args.instance);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--instance 需要非负整数，收到 ${args.instance}`);
  }
  return n;
}

/**
 * 决定要跑哪些入口。
 * 优先级：--tasks > config.instances[].tasks（非空且都能解析）> 自动发现。
 *
 * @returns {{entries: string[], source: string}}
 */
export function decideEntries(config, inst, args, nodes, logger) {
  if (args.tasks && args.tasks !== true) {
    const list = String(args.tasks)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) throw new Error('--tasks 为空');
    return { entries: list, source: '--tasks' };
  }

  const configured = (inst.tasks ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (configured.length > 0 && args.all !== true) {
    const resolved = configured.map((e) => resolveEntry(e, nodes, null));
    const unknown = resolved.filter((e) => !nodes.includes(e));
    if (unknown.length === 0) {
      return { entries: configured, source: 'config.instances[].tasks' };
    }
    logger?.warn(
      `配置里的任务无法解析：${unknown.join(', ')}；改用自动发现` +
        '（想固定顺序请修正 config/config.json 的 instances[].tasks）',
    );
  }

  const modules = discoverModules();
  for (const m of modules.filter((x) => !x.ok)) {
    logger?.warn(`跳过无法解析的模块 ${m.file}：${m.error}`);
  }
  return {
    entries: modules.filter((m) => m.ok).map((m) => m.entry),
    source: '自动发现（按文件名顺序）',
  };
}
