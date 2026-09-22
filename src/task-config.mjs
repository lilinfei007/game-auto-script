/**
 * 任务集（`config/tasks.json`）：把流水线模块组织成「有序 + 可开关 + 可带参数」的任务，
 * 供界面编排与一键执行。
 *
 * 为什么单独一个文件而不是塞进 config/config.json：
 *   - `config.json` 管设备与运行参数（跟机器绑定，换了电脑就要改）；
 *   - 任务集是「我要跑什么、按什么顺序」（跟玩法绑定，应当入库、可以分享）。
 *   两者变更频率与归属都不同，混在一起会让界面保存时互相覆盖。
 *
 * 本模块除了 `readTaskConfig / writeTaskConfig` 之外全是**纯函数**，可脱离文件系统单测。
 */
import fs from 'node:fs';

import { PATHS, stripJsonComments } from './config.mjs';
import { writeFileAtomic, backupFile } from './util/fsx.mjs';
import { discoverModules, resolveEntry } from './resource.mjs';
import { parseCron } from './schedule.mjs';

export const TASKS_VERSION = 1;

/** preset id 允许的形态：小写字母数字开头，可含 `_` `-`。 */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 步骤 entry 允许的形态：节点名或流水线文件名，允许中文。 */
export const ENTRY_RE = /^[^\s/\\:*?"<>|]{1,64}$/;

/** 可从界面覆盖的运行时参数（与 config.RUNTIME_OVERRIDE_TYPES 的键保持一致）。 */
export const RUNTIME_KEYS = new Set([
  'shortSide',
  'launchTimeoutMs',
  'taskTimeoutMs',
  'saveDraws',
  'saveOnError',
  'saveFailureShot',
  'logLevel',
]);

export const DEFAULT_TASK_CONFIG = {
  version: TASKS_VERSION,
  defaults: {
    instance: 0,
    retry: 0,
    taskTimeoutMs: 600000,
  },
  presets: [],
};

/** 深拷贝默认任务集（避免调用方改到共享常量）。 */
export function defaultTaskConfig() {
  return structuredClone(DEFAULT_TASK_CONFIG);
}

// ---------------------------------------------------------------- 校验

/**
 * 校验一份任务集。返回 `{errors, warnings}`，**不抛异常**（校验结果要直接喂给界面）。
 *
 * @param {object} obj 待校验对象
 * @param {object} [options]
 * @param {string[]} [options.knownNodes] 资源里真实存在的节点名；给了就校验 entry 可解析
 */
export function validateTaskConfig(obj, options = {}) {
  const errors = [];
  const warnings = [];
  const knownNodes = options.knownNodes ?? null;

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { errors: ['任务集顶层必须是对象'], warnings };
  }
  if (obj.version !== undefined && obj.version !== TASKS_VERSION) {
    errors.push(`version 必须是 ${TASKS_VERSION}，收到 ${JSON.stringify(obj.version)}`);
  }

  const { errors: derr, warnings: dwarn } = validateDefaults(obj.defaults);
  errors.push(...derr);
  warnings.push(...dwarn);

  if (!Array.isArray(obj.presets)) {
    errors.push('presets 必须是数组');
    return { errors, warnings };
  }

  const seenIds = new Set();
  obj.presets.forEach((preset, i) => {
    const at = `presets[${i}]`;
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
      errors.push(`${at} 必须是对象`);
      return;
    }
    if (typeof preset.id !== 'string' || !PRESET_ID_RE.test(preset.id)) {
      errors.push(
        `${at}.id 非法（小写字母/数字开头，可含 _ -，最长 32 位）：${JSON.stringify(preset.id)}`,
      );
    } else if (seenIds.has(preset.id)) {
      errors.push(`${at}.id 重复：${preset.id}`);
    } else {
      seenIds.add(preset.id);
    }

    if (preset.name !== undefined && (typeof preset.name !== 'string' || !preset.name.trim())) {
      errors.push(`${at}.name 必须是非空字符串`);
    }
    if (preset.enabled !== undefined && typeof preset.enabled !== 'boolean') {
      errors.push(`${at}.enabled 必须是布尔值`);
    }
    if (preset.instance !== undefined && (!Number.isInteger(preset.instance) || preset.instance < 0)) {
      errors.push(`${at}.instance 必须是非负整数`);
    }
    if (
      preset.retry !== undefined &&
      (!Number.isInteger(preset.retry) || preset.retry < 0 || preset.retry > 5)
    ) {
      errors.push(`${at}.retry 必须是 0-5 的整数`);
    }
    if (preset.runtime !== undefined) {
      if (!preset.runtime || typeof preset.runtime !== 'object' || Array.isArray(preset.runtime)) {
        errors.push(`${at}.runtime 必须是对象`);
      } else {
        for (const key of Object.keys(preset.runtime)) {
          if (!RUNTIME_KEYS.has(key)) {
            warnings.push(`${at}.runtime.${key} 不是可覆盖的运行时参数，将被忽略`);
          }
        }
      }
    }

    const { errors: serr, warnings: swarn } = validateSteps(preset.steps, `${at}.steps`, knownNodes);
    errors.push(...serr);
    warnings.push(...swarn);

    const { errors: cherr, warnings: cwarn } = validateSchedule(preset.schedule, `${at}.schedule`);
    errors.push(...cherr);
    warnings.push(...cwarn);
  });

  return { errors, warnings };
}

function validateDefaults(defaults) {
  const errors = [];
  const warnings = [];
  if (defaults === undefined) return { errors, warnings };
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return { errors: ['defaults 必须是对象'], warnings };
  }
  if (defaults.instance !== undefined && (!Number.isInteger(defaults.instance) || defaults.instance < 0)) {
    errors.push('defaults.instance 必须是非负整数');
  }
  if (
    defaults.retry !== undefined &&
    (!Number.isInteger(defaults.retry) || defaults.retry < 0 || defaults.retry > 5)
  ) {
    errors.push('defaults.retry 必须是 0-5 的整数');
  }
  if (
    defaults.taskTimeoutMs !== undefined &&
    (!Number.isInteger(defaults.taskTimeoutMs) || defaults.taskTimeoutMs <= 0)
  ) {
    errors.push('defaults.taskTimeoutMs 必须是正整数（毫秒）');
  }
  return { errors, warnings };
}

function validateSteps(steps, at, knownNodes) {
  const errors = [];
  const warnings = [];
  if (steps === undefined) return { errors, warnings };
  if (!Array.isArray(steps)) return { errors: [`${at} 必须是数组`], warnings };

  const seen = new Set();
  steps.forEach((step, i) => {
    const where = `${at}[${i}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`${where} 必须是对象`);
      return;
    }
    if (typeof step.entry !== 'string' || !ENTRY_RE.test(step.entry)) {
      errors.push(`${where}.entry 非法：${JSON.stringify(step.entry)}`);
      return;
    }
    if (seen.has(step.entry)) {
      // 同一个入口跑两遍是合法需求（中间隔了别的任务），只提示
      warnings.push(`${where}.entry 重复出现：${step.entry}`);
    }
    seen.add(step.entry);

    if (step.enabled !== undefined && typeof step.enabled !== 'boolean') {
      errors.push(`${where}.enabled 必须是布尔值`);
    }
    if (step.label !== undefined && (typeof step.label !== 'string' || step.label.length > 64)) {
      errors.push(`${where}.label 必须是 64 字以内的字符串`);
    }
    if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs <= 0)) {
      errors.push(`${where}.timeoutMs 必须是正整数（毫秒）`);
    }
    if (knownNodes && !knownNodes.includes(resolveEntry(step.entry, knownNodes, null))) {
      errors.push(`${where}.entry 无法解析成任何节点：${step.entry}`);
    }
  });
  return { errors, warnings };
}

function validateSchedule(schedule, at) {
  const errors = [];
  const warnings = [];
  if (schedule === undefined) return { errors, warnings };
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return { errors: [`${at} 必须是对象`], warnings };
  }
  if (schedule.enabled !== undefined && typeof schedule.enabled !== 'boolean') {
    errors.push(`${at}.enabled 必须是布尔值`);
  }
  if (schedule.timezone !== undefined && schedule.timezone !== 'local') {
    warnings.push(`${at}.timezone 目前只支持 'local'，收到 ${JSON.stringify(schedule.timezone)}`);
  }
  if (schedule.cron === undefined || (typeof schedule.cron === 'string' && schedule.cron.trim() === '')) {
    // 关闭状态下空 cron 是合法默认值；开启就必须给表达式
    if (schedule.enabled === true) errors.push(`${at}.cron 在 enabled 为 true 时必填`);
    return { errors, warnings };
  }
  if (typeof schedule.cron !== 'string') {
    errors.push(`${at}.cron 必须是字符串`);
    return { errors, warnings };
  }

  const parsed = parseCron(schedule.cron);
  if (!parsed.ok) errors.push(`${at}.cron 无法解析：${parsed.error}`);
  return { errors, warnings };
}

// ---------------------------------------------------------------- 读写

/** 读取任务集（允许 JSONC 注释）。文件不存在时返回默认值且 `exists:false`。 */
export function readTaskConfig() {
  if (!fs.existsSync(PATHS.tasksFile)) {
    return { config: defaultTaskConfig(), exists: false, mtime: null, errors: [], warnings: [] };
  }
  let obj;
  let mtime = null;
  try {
    mtime = fs.statSync(PATHS.tasksFile).mtimeMs;
    obj = JSON.parse(stripJsonComments(fs.readFileSync(PATHS.tasksFile, 'utf8')));
  } catch (e) {
    return {
      config: defaultTaskConfig(),
      exists: true,
      mtime,
      errors: [`config/tasks.json 解析失败：${e.message}`],
      warnings: [],
    };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { config: defaultTaskConfig(), exists: true, mtime, errors: ['任务集顶层必须是对象'], warnings: [] };
  }
  const { errors, warnings } = validateTaskConfig(obj);
  return { config: normalizeTaskConfig(obj), exists: true, mtime, errors, warnings };
}

/** 补齐缺省字段，返回可直接使用的任务集（不写盘）。 */
export function normalizeTaskConfig(obj) {
  const base = defaultTaskConfig();
  const out = {
    version: TASKS_VERSION,
    defaults: { ...base.defaults, ...(obj?.defaults ?? {}) },
    presets: [],
  };
  out.presets = (Array.isArray(obj?.presets) ? obj.presets : []).map((p) => ({
    id: String(p?.id ?? ''),
    name: typeof p?.name === 'string' && p.name.trim() ? p.name : String(p?.id ?? '未命名'),
    enabled: p?.enabled !== false,
    ...(p?.instance !== undefined ? { instance: p.instance } : {}),
    ...(p?.retry !== undefined ? { retry: p.retry } : {}),
    ...(p?.runtime && typeof p.runtime === 'object' ? { runtime: { ...p.runtime } } : {}),
    steps: (Array.isArray(p?.steps) ? p.steps : []).map((s) => ({
      entry: String(s?.entry ?? ''),
      enabled: s?.enabled !== false,
      ...(s?.label ? { label: String(s.label) } : {}),
      ...(s?.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
    })),
    schedule: {
      enabled: p?.schedule?.enabled === true,
      cron: typeof p?.schedule?.cron === 'string' ? p.schedule.cron : '',
      timezone: 'local',
    },
  }));
  return out;
}

/**
 * 写入任务集：先备份旧文件，再原子落盘。
 * 校验不通过直接抛错，避免把坏数据写进磁盘。
 */
export function writeTaskConfig(obj, options = {}) {
  const { errors } = validateTaskConfig(obj, options);
  if (errors.length > 0) {
    throw new Error(`任务集校验未通过：${errors.join('；')}`);
  }
  const backup = backupFile(PATHS.tasksFile, PATHS.configBackups);
  writeFileAtomic(PATHS.tasksFile, `${JSON.stringify(obj, null, 2)}\n`);
  return { file: PATHS.tasksFile, backup };
}

// ---------------------------------------------------------------- 查询与变更

export function getPreset(config, id) {
  return (config.presets ?? []).find((p) => p.id === id) ?? null;
}

/**
 * 把 preset 解析成「要执行的入口列表」：过滤开关关闭的步骤，
 * 并把文件名解析成节点名；顺序即执行顺序。
 */
export function resolvePresetSteps(preset, knownNodes, logger) {
  const steps = (preset?.steps ?? []).filter((s) => s.enabled !== false);
  const entries = [];
  const timeouts = {};
  for (const s of steps) {
    const entry = resolveEntry(s.entry, knownNodes, logger);
    entries.push(entry);
    if (s.timeoutMs !== undefined) timeouts[entry] = s.timeoutMs;
  }
  return { entries, timeouts, steps };
}

/** 从已发现的模块生成一个新 preset（界面「新建任务集」用）。 */
export function blankPreset(id, name, modules = discoverModules(), opts = {}) {
  return {
    id,
    name: name || id,
    enabled: true,
    ...(opts.instance !== undefined ? { instance: opts.instance } : {}),
    steps: modules.filter((m) => m.ok).map((m) => ({ entry: m.entry, enabled: opts.allEnabled !== false })),
    schedule: { enabled: false, cron: '', timezone: 'local' },
  };
}

/**
 * 按给定顺序重排某个 preset 的步骤。
 * 只接受「与现有步骤集合相同」的顺序，避免界面传错就悄悄丢步骤。
 */
export function reorderSteps(preset, order) {
  if (!Array.isArray(order)) throw new Error('order 必须是数组');
  const byEntry = new Map();
  for (const s of preset.steps ?? []) {
    if (!byEntry.has(s.entry)) byEntry.set(s.entry, []);
    byEntry.get(s.entry).push(s);
  }
  const out = [];
  for (const entry of order) {
    const queue = byEntry.get(entry);
    if (!queue || queue.length === 0) throw new Error(`order 里有不存在的步骤：${entry}`);
    out.push(queue.shift());
  }
  const rest = [...byEntry.values()].flat();
  if (rest.length > 0) {
    throw new Error(`order 缺少步骤：${rest.map((s) => s.entry).join(', ')}`);
  }
  return { ...preset, steps: out };
}

/** 打开/关闭某个步骤（同名入口可用 index 指定第几个）。 */
export function toggleStep(preset, entry, enabled, index = 0) {
  let seen = 0;
  const steps = (preset.steps ?? []).map((s) => {
    if (s.entry !== entry) return s;
    if (seen++ !== index) return s;
    return { ...s, enabled: !!enabled };
  });
  return { ...preset, steps };
}

/** 新增/覆盖一个 preset（按 id 匹配）。 */
export function upsertPreset(config, preset) {
  const presets = [...(config.presets ?? [])];
  const i = presets.findIndex((p) => p.id === preset.id);
  if (i >= 0) presets[i] = preset;
  else presets.push(preset);
  return { ...config, presets };
}

/** 删除一个 preset；不存在返回原对象。 */
export function removePreset(config, id) {
  const presets = (config.presets ?? []).filter((p) => p.id !== id);
  if (presets.length === (config.presets ?? []).length) return config;
  return { ...config, presets };
}

/** 生成一个不与现有 id 冲突的 preset id。 */
export function uniquePresetId(config, base = 'preset') {
  const used = new Set((config.presets ?? []).map((p) => p.id));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('无法生成唯一的 preset id');
}

/**
 * 把 preset 的步骤与「自动发现的模块」对齐：
 * 新增的模块追加到末尾（默认关闭，避免新模块突然被跑），消失的模块标记为失效。
 * 界面用它提示「有模块被删掉/新增」。
 */
export function reconcilePreset(preset, modules) {
  const known = modules.filter((m) => m.ok).map((m) => m.entry);
  const have = new Set((preset.steps ?? []).map((s) => s.entry));
  const missing = (preset.steps ?? []).filter((s) => !known.includes(resolveEntry(s.entry, known, null)));
  const added = known.filter((e) => !have.has(e));
  return {
    missing: missing.map((s) => s.entry),
    added,
    preset: {
      ...preset,
      steps: [
        ...(preset.steps ?? []),
        ...added.map((entry) => ({ entry, enabled: false })),
      ],
    },
  };
}

/** 任务集里是否配置了任何定时任务（调度器据此决定要不要起 tick）。 */
export function hasScheduledPresets(config) {
  return (config.presets ?? []).some((p) => p.schedule?.enabled === true && !!p.schedule.cron);
}

/** 任务集文件的 mtime，界面用它检测「被外部改动过」。 */
export function taskConfigMtime() {
  try {
    return fs.statSync(PATHS.tasksFile).mtimeMs;
  } catch {
    return null;
  }
}
