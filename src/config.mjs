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

/** 允许的日志等级（单一来源：util/log.mjs）。 */
export const LOG_LEVELS = Object.keys(LEVELS);

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PATHS = {
  root: ROOT,
  configFile: path.join(ROOT, 'config', 'config.json'),
  resource: path.join(ROOT, 'resource'),
  pipeline: path.join(ROOT, 'resource', 'pipeline'),
  image: path.join(ROOT, 'resource', 'image'),
  rawImage: path.join(ROOT, 'resource', 'image', '_raw'),
  ocrModel: path.join(ROOT, 'resource', 'model', 'ocr'),
  debug: path.join(ROOT, 'debug'),
  onError: path.join(ROOT, 'debug', 'on_error'),
  draws: path.join(ROOT, 'debug', 'draws'),
  recording: path.join(ROOT, 'debug', 'recording'),
  docsReference: path.join(ROOT, 'docs', 'reference'),
};

/** 包名占位符：doctor 会据此提示尚未填写。 */
export const PACKAGE_PLACEHOLDER = 'TODO_SET_ME';

export const DEFAULT_CONFIG = {
  mumu: {
    path: 'D:/MuMu',
    manager: 'D:/MuMu/nx_main/MuMuManager.exe',
    adb: 'D:/MuMu/nx_main/adb.exe',
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
 * @returns {{ config: object, exists: boolean, errors: string[], warnings: string[] }}
 */
export function loadConfig() {
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
  const { errors: verrs, warnings: vwarns } = validateConfig(config);
  errors.push(...verrs);
  warnings.push(...vwarns);

  return { config, exists, errors, warnings };
}

/**
 * 校验一份**已合并**的配置。
 *
 * 抽成纯函数是为了可测：loadConfig 要读真实文件，而校验规则本身不该依赖文件系统。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  // --- 校验 mumu ---
  if (!config.mumu?.path) {
    errors.push('mumu.path 未设置');
  } else if (!fs.existsSync(config.mumu.path)) {
    errors.push(`找不到 MuMu 安装目录: ${config.mumu.path}`);
  }
  if (!config.mumu?.manager) {
    errors.push('mumu.manager 未设置');
  } else if (!fs.existsSync(config.mumu.manager)) {
    errors.push(`找不到 MuMuManager.exe: ${config.mumu.manager}`);
  }
  if (!config.mumu?.adb) {
    errors.push('mumu.adb 未设置');
  } else if (!fs.existsSync(config.mumu.adb)) {
    errors.push(`找不到 adb.exe: ${config.mumu.adb}`);
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
  for (const d of [PATHS.debug, PATHS.onError, PATHS.draws]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
