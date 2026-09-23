/**
 * 配置加载与路径解析。
 *
 * 约定：
 *  - 项目根由本文件位置推导（src/ 的上一级），与 cwd 无关。
 *  - 实例 ADB 端口 = basePort + portStep * index（MuMu 约定步长 32）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS } from './util/log.mjs';
import { applyMumuDetection } from './mumu-detect.mjs';

/** 允许的日志等级（单一来源：util/log.mjs）。 */
export const LOG_LEVELS = Object.keys(LEVELS);

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PATHS = {
  root: ROOT,
  configFile: path.join(ROOT, 'config', 'config.json'),
  /** 任务集（模块组合 + 顺序 + 开关 + 参数），入库存放。 */
  tasksFile: path.join(ROOT, 'config', 'tasks.json'),
  resource: path.join(ROOT, 'resource'),
  pipeline: path.join(ROOT, 'resource', 'pipeline'),
  image: path.join(ROOT, 'resource', 'image'),
  rawImage: path.join(ROOT, 'resource', 'image', '_raw'),
  ocrModel: path.join(ROOT, 'resource', 'model', 'ocr'),
  debug: path.join(ROOT, 'debug'),
  onError: path.join(ROOT, 'debug', 'on_error'),
  draws: path.join(ROOT, 'debug', 'draws'),
  recording: path.join(ROOT, 'debug', 'recording'),
  /** 从界面改配置/流水线前的自动备份（保留最近若干份）。 */
  configBackups: path.join(ROOT, 'debug', 'config-backups'),
  pipelineBackups: path.join(ROOT, 'debug', 'pipeline-backups'),
  /** 调度执行历史（JSON Lines）。 */
  scheduleLog: path.join(ROOT, 'debug', 'schedule.jsonl'),
  docsReference: path.join(ROOT, 'docs', 'reference'),
};

/** 包名占位符：doctor 会据此提示尚未填写。 */
export const PACKAGE_PLACEHOLDER = 'TODO_SET_ME';

export const DEFAULT_CONFIG = {
  mumu: {
    // 留空 = 自动检测（环境变量 → 注册表 → 常见安装目录 → PATH）。
    // 写死了会把「某台机器的路径」带进入库的 config.json，换机器就得手改。
    // 需要固定时再显式填，显式值永远优先于检测结果。见 src/mumu-detect.mjs
    path: '',
    manager: '',
    adb: '',
    basePort: 16384,
    portStep: 32,
  },
  game: {
    package: PACKAGE_PLACEHOLDER,
  },
  runtime: {
    shortSide: 720,
    launchTimeoutMs: 90000,
    taskTimeoutMs: 600000,
    saveDraws: false,
    // 框架在失败瞬间保存截图，文件名带**节点名**（更准，默认开）
    saveOnError: true,
    // 本项目在失败后再存一张，文件名带**任务名**（便于检索，默认关，避免重复占盘）
    saveFailureShot: false,
    logLevel: 'info',
  },
  // tasks 留空 = 自动按文件名顺序跑 resource/pipeline 下的所有模块
  instances: [{ index: 0, enabled: true, tasks: [] }],
};

function deepMerge(base, override) {
  if (override === undefined || override === null) return structuredClone(base);
  if (Array.isArray(base) || typeof base !== 'object') return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 读取并校验配置。文件不存在时返回默认配置（并标记 created=false）。
 *
 * MuMu 的三条路径留空时会在这一步自动检测补上（只填空值）。
 *
 * @param {object} [options]
 * @param {boolean} [options.strictPaths=false] 路径不存在算错误（doctor 用）
 * @param {boolean} [options.detectMumu=true] 是否自动检测 MuMu 路径（测试可关掉）
 * @param {object} [options.mumuDetect] 透传给 detectMumu 的选项（测试可注入候选目录）
 * @returns {{ config: object, exists: boolean, errors: string[], warnings: string[] }}
 */
export function loadConfig(options = {}) {
  const errors = [];
  const warnings = [];
  let raw = {};
  let exists = false;

  if (fs.existsSync(PATHS.configFile)) {
    exists = true;
    try {
      raw = JSON.parse(stripJsonComments(fs.readFileSync(PATHS.configFile, 'utf8')));
    } catch (e) {
      errors.push(`config/config.json 解析失败: ${e.message}`);
      raw = {};
    }
  }

  const config = deepMerge(DEFAULT_CONFIG, raw);
  if (options.detectMumu !== false) applyMumuDetection(config, options.mumuDetect ?? {});
  const { errors: verrs, warnings: vwarns } = validateConfig(config, options);
  errors.push(...verrs);
  warnings.push(...vwarns);

  return { config, exists, errors, warnings };
}

/**
 * 校验一份**已合并**的配置。
 *
 * 抽成纯函数是为了可测：loadConfig 要读真实文件，而校验规则本身不该依赖文件系统。
 *
 * 关于路径存在性：默认可执行文件**找不到只给警告**，不给错误。
 * 理由：`validateConfig` 的结果会挡住整个进程启动，而界面、`list`、`run --dry-run`、
 * 流水线校验这些功能根本不需要模拟器。找不到路径这件事由 `doctor` 报成致命错误
 * （它本来就会实际连一次设备），那时才是真正该拦下来的地方。
 *
 * @param {object} config
 * @param {object} [options]
 * @param {boolean} [options.strictPaths=false] 为 true 时路径不存在算错误（doctor 用）
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateConfig(config, options = {}) {
  const errors = [];
  const warnings = [];
  const strictPaths = options.strictPaths === true;
  /** 路径类问题：严格模式进 errors，否则进 warnings。 */
  const pathIssue = (msg) => (strictPaths ? errors.push(msg) : warnings.push(msg));

  // --- 校验 mumu ---
  //
  // 路径留空 = 自动检测没找到。这**只给警告**，不是错误：没装模拟器的机器
  // 也要能用界面 / `list` / `run --dry-run`，真正的拦截交给 doctor 的实连检查。
  // 反过来，用户**显式写了**却不存在的路径要给重话 —— 那多半是打错了。
  const missingMumu = ['path', 'manager', 'adb'].filter((k) => !config.mumu?.[k]);
  if (missingMumu.length > 0) {
    warnings.push(
      `未自动检测到 MuMu（缺 ${missingMumu.join(' / ')}）。` +
        '确认已安装 MuMu；或设置环境变量 MUMU_PATH（安装目录）/ MUMU_MANAGER（MuMuManager.exe），' +
        '或在 config/config.json 里显式填写 mumu.manager 与 mumu.adb',
    );
  }
  for (const [key, label] of [
    ['path', 'MuMu 安装目录'],
    ['manager', 'MuMuManager.exe'],
    ['adb', 'adb.exe'],
  ]) {
    const value = config.mumu?.[key];
    if (value && !fs.existsSync(value)) pathIssue(`找不到 ${label}: ${value}`);
  }
  if (
    !Number.isInteger(config.mumu?.basePort) ||
    config.mumu.basePort < 1 ||
    config.mumu.basePort > 65535
  ) {
    errors.push(`mumu.basePort 必须是 1-65535 的整数，收到 ${JSON.stringify(config.mumu?.basePort)}`);
  }
  if (!Number.isInteger(config.mumu?.portStep) || config.mumu.portStep < 1) {
    errors.push(`mumu.portStep 必须是正整数，收到 ${JSON.stringify(config.mumu?.portStep)}`);
  }

  // --- 校验 game ---
  if (!config.game?.package) {
    errors.push('game.package 未设置');
  } else if (config.game.package === PACKAGE_PLACEHOLDER) {
    warnings.push(
      `game.package 仍是占位符（${PACKAGE_PLACEHOLDER}）；` +
        '请用 `adb shell pm list packages` 查出《无尽冬日》包名后填入 config/config.json',
    );
  }

  // --- 校验 instances ---
  if (!Array.isArray(config.instances) || config.instances.length === 0) {
    errors.push('instances 必须是非空数组');
  } else {
    const seen = new Set();
    for (const inst of config.instances) {
      if (!Number.isInteger(inst?.index) || inst.index < 0) {
        errors.push(`instances 中存在非法 index: ${JSON.stringify(inst?.index)}`);
        continue;
      }
      if (seen.has(inst.index)) errors.push(`instances 中 index 重复: ${inst.index}`);
      seen.add(inst.index);
      if (inst.tasks !== undefined) {
        if (!Array.isArray(inst.tasks)) {
          errors.push(`instances[${inst.index}].tasks 必须是字符串数组`);
        } else if (inst.tasks.some((t) => typeof t !== 'string' || t.trim() === '')) {
          errors.push(`instances[${inst.index}].tasks 里有空项或非字符串`);
        }
      }
    }
  }

  if (!Number.isInteger(config.runtime?.shortSide) || config.runtime.shortSide <= 0) {
    errors.push('runtime.shortSide 必须是正整数');
  }
  for (const key of ['launchTimeoutMs', 'taskTimeoutMs']) {
    const v = config.runtime?.[key];
    if (!Number.isInteger(v) || v <= 0) {
      errors.push(`runtime.${key} 必须是正整数（毫秒），收到 ${JSON.stringify(v)}`);
    }
  }
  if (!LOG_LEVELS.includes(config.runtime?.logLevel)) {
    errors.push(`runtime.logLevel 必须是 ${LOG_LEVELS.join(' / ')} 之一，收到 ${JSON.stringify(config.runtime?.logLevel)}`);
  }

  return { errors, warnings };
}

/** 去掉 JSONC 的 // 与 /* *\/ 注释（配置里允许写注释）。 */
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** 由实例索引算出 ADB 地址。 */
export function resolveInstance(config, index) {
  const { basePort, portStep } = config.mumu;
  const port = basePort + portStep * index;
  return { index, port, address: `127.0.0.1:${port}` };
}

/** 取启用中的实例；未指定 index 时取第一个。 */
export function pickInstances(config, index) {
  const enabled = config.instances.filter((i) => i.enabled !== false);
  if (index === undefined || index === null) return enabled;
  const found = enabled.find((i) => i.index === index);
  if (!found) {
    throw new Error(
      `实例 ${index} 不存在或未启用。可用: ${enabled.map((i) => i.index).join(', ') || '(无)'}`,
    );
  }
  return [found];
}

/** 确保 debug 相关目录存在。 */
export function ensureDebugDirs() {
  for (const d of [PATHS.debug, PATHS.onError, PATHS.draws, PATHS.recording]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** 允许从界面覆盖的运行时参数及其类型（防止把垃圾字段写进 config）。 */
export const RUNTIME_OVERRIDE_TYPES = {
  shortSide: 'int',
  launchTimeoutMs: 'int',
  taskTimeoutMs: 'int',
  saveDraws: 'bool',
  saveOnError: 'bool',
  saveFailureShot: 'bool',
  logLevel: 'logLevel',
};

/**
 * 过滤一份运行时参数覆盖：丢掉未知字段与类型不符的值。
 *
 * 界面传上来的东西不可信，而 `config.runtime` 会直接影响执行行为
 * （例如 `taskTimeoutMs` 写成字符串会让超时判断失效），所以统一在这里收口。
 *
 * @returns {{clean: object, rejected: Array<{key:string, reason:string}>}}
 */
export function sanitizeRuntimeOverrides(override) {
  const clean = {};
  const rejected = [];
  if (override === undefined || override === null) return { clean, rejected };
  if (typeof override !== 'object' || Array.isArray(override)) {
    return { clean, rejected: [{ key: '(整体)', reason: '必须是对象' }] };
  }

  for (const [key, value] of Object.entries(override)) {
    const kind = RUNTIME_OVERRIDE_TYPES[key];
    if (!kind) {
      rejected.push({ key, reason: '不是可覆盖的运行时参数' });
      continue;
    }
    if (kind === 'int') {
      if (!Number.isInteger(value) || value <= 0) {
        rejected.push({ key, reason: '必须是正整数' });
        continue;
      }
    } else if (kind === 'bool') {
      if (typeof value !== 'boolean') {
        rejected.push({ key, reason: '必须是布尔值' });
        continue;
      }
    } else if (kind === 'logLevel') {
      if (!LOG_LEVELS.includes(value)) {
        rejected.push({ key, reason: `必须是 ${LOG_LEVELS.join(' / ')} 之一` });
        continue;
      }
    }
    clean[key] = value;
  }
  return { clean, rejected };
}

/**
 * 在**内存里**套用运行时参数覆盖，返回新配置对象。
 *
 * 刻意不写盘：界面上的临时调整（本次跑重试 2 次、临时关掉失败截图）
 * 不应该污染 `config/config.json`。要永久生效请走 PUT /api/config。
 *
 * @returns {{config: object, rejected: Array<{key:string, reason:string}>}}
 */
export function applyRuntimeOverrides(config, override) {
  const { clean, rejected } = sanitizeRuntimeOverrides(override);
  if (Object.keys(clean).length === 0) return { config, rejected };
  return { config: { ...config, runtime: { ...config.runtime, ...clean } }, rejected };
}

