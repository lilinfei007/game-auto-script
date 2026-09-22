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
import path from 'node:path';

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

/**
 * 读取任务集（允许 JSONC 注释）。文件不存在时返回默认值且 `exists:false`。
 *
 * @param {object} [options]
 * @param {string} [options.file] 指定文件路径（测试用临时文件，避免动真实任务集）
 * @param {string[]} [options.knownNodes] 给了就顺带校验每个 entry 能否解析
 */
export function readTaskConfig(options = {}) {
  const file = options.file ?? PATHS.tasksFile;
  if (!fs.existsSync(file)) {
    return { config: defaultTaskConfig(), exists: false, mtime: null, file, errors: [], warnings: [] };
  }
  let obj;
  let mtime = null;
  try {
    mtime = fs.statSync(file).mtimeMs;
    obj = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return {
      config: defaultTaskConfig(),
      exists: true,
      mtime,
      file,
      errors: [`${path.basename(file)} 解析失败：${e.message}`],
      warnings: [],
    };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      config: defaultTaskConfig(),
      exists: true,
      mtime,
      file,
      errors: ['任务集顶层必须是对象'],
      warnings: [],
    };
  }
  const { errors, warnings } = validateTaskConfig(obj, { knownNodes: options.knownNodes });
  return { config: normalizeTaskConfig(obj), exists: true, mtime, file, errors, warnings };
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
 *
 * @param {object} [options]
 * @param {string} [options.file] 指定文件路径（测试用）
 * @param {string[]} [options.knownNodes] 给了就校验每个 entry 能否解析
 * @param {number} [options.expectedMtime] 期望的旧 mtime；不一致则拒绝（防覆盖外部编辑）
 */
export function writeTaskConfig(obj, options = {}) {
  const file = options.file ?? PATHS.tasksFile;
  const { errors } = validateTaskConfig(obj, options);
  if (errors.length > 0) {
    throw new Error(`任务集校验未通过：${errors.join('；')}`);
  }
  assertUnchanged(file, options.expectedMtime);
  const backup = backupFile(file, PATHS.configBackups);
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
  return { file, backup };
}

/**
 * 比对文件是否被外部改动过。
 *
 * 界面在读取时会拿到 mtime，保存时带回来；不一致说明期间有人（或另一个编辑器）
 * 改过这个文件，此时直接拒绝比默默覆盖安全。允许 1ms 误差以容忍文件系统精度差异。
 */
function assertUnchanged(file, expectedMtime) {
  if (expectedMtime === undefined || expectedMtime === null) return;
  const actual = fs.existsSync(file) ? fs.statSync(file).mtimeMs : null;
  if (actual !== null && Math.abs(actual - expectedMtime) > 1) {
    throw new Error('任务集文件已被外部修改，请重新加载后再保存（避免覆盖你在编辑器里的改动）');
  }
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

/**
 * 界面用的 preset 视图：把每个步骤解析成真实节点名，并标出是否还有效。
 *
 * 解析失败不抛错（模块被删掉是很常见的情况），而是标 `ok:false`，
 * 让编排面板能显示「这个模块已不存在」而不是整页崩掉。
 */
export function describePreset(preset, knownNodes) {
  const steps = (preset?.steps ?? []).map((s, i) => {
    const entry = resolveEntry(s.entry, knownNodes, null);
    const exists = knownNodes.includes(entry);
    return {
      index: i,
      raw: s.entry,
      entry,
      ok: exists,
      enabled: s.enabled !== false,
      label: s.label ?? null,
      timeoutMs: s.timeoutMs ?? null,
    };
  });
  const enabledSteps = steps.filter((s) => s.enabled);
  return {
    id: preset?.id ?? '',
    name: preset?.name ?? '',
    enabled: preset?.enabled !== false,
    instance: preset?.instance ?? null,
    retry: preset?.retry ?? null,
    runtime: preset?.runtime ?? null,
    schedule: preset?.schedule ?? { enabled: false, cron: '', timezone: 'local' },
    steps,
    enabledCount: enabledSteps.length,
    broken: steps.filter((s) => !s.ok).map((s) => s.raw),
    // 界面据此提示「这个任务集现在跑起来什么都不会做」
    runnable: enabledSteps.length > 0,
  };
}

/**
 * 把「预设 + 本次请求的覆盖」解析成执行层要的 opts。
 *
 * 优先级（从高到低）：
 *   1. 请求体显式给的值（临时改一下再跑）
 *   2. preset 上的字段
 *   3. 交给执行层回落到 config.runtime / config.instances
 *
 * @param {object} preset
 * @param {string[]} knownNodes
 * @param {object} [overrides] `{ instance, retry, runtime }`
 * @returns {{entries:string[], stepTimeouts:Record<string,number>, instance?:number, retry:number, runtime?:object, preset:string, presetName:string}}
 */
export function resolvePresetRun(preset, knownNodes, overrides = {}) {
  if (!preset) throw new Error('找不到这个任务集');
  if (preset.enabled === false) throw new Error(`任务集「${preset.name || preset.id}」已被停用`);

  const { entries, timeouts } = resolvePresetSteps(preset, knownNodes, null);
  if (entries.length === 0) {
    throw new Error(`任务集「${preset.name || preset.id}」没有任何启用的步骤`);
  }

  const pick = (key) => {
    if (overrides[key] !== undefined && overrides[key] !== null) return overrides[key];
    return preset[key];
  };

  const instance = pick('instance');
  const retry = pick('retry');
  const runtime = pick('runtime');

  return {
    entries,
    stepTimeouts: timeouts,
    ...(Number.isInteger(instance) ? { instance } : {}),
    retry: Number.isInteger(retry) ? Math.max(0, retry) : 0,
    ...(runtime && typeof runtime === 'object' ? { runtime } : {}),
    preset: preset.id,
    presetName: preset.name || preset.id,
  };
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

/** 定位某个步骤（同名入口按出现次序）。找不到返回 -1。 */
export function findStepIndex(preset, entry, index = 0) {
  let seen = 0;
  const steps = preset?.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].entry !== entry) continue;
    if (seen++ === index) return i;
  }
  return -1;
}

/**
 * 应用一批步骤操作，返回新 preset。
 *
 * 与 `reorderSteps` / `toggleStep` 的区别：那两个在出错时抛异常，
 * 适合内部调用；这个把错误收成数组返回，方便接口层一次性回传给界面
 * （界面要能一次看到「哪几个操作不合法」）。所有操作都是**纯函数**，不落盘。
 *
 * 支持的操作：
 *   `{ op:'reorder', order:[entry,...] }`  按给定顺序重排（集合必须完全一致）
 *   `{ op:'toggle',  entry, enabled }`     开关
 *   `{ op:'move',    entry, delta }`       上移/下移
 *   `{ op:'label',   entry, label }`       改标注
 *   `{ op:'timeout', entry, timeoutMs }`   改单步超时（null 表示清除）
 *   `{ op:'remove',  entry }`              删除步骤
 *   `{ op:'add',     entry, enabled }`     追加步骤到末尾
 *
 * @returns {{preset: object|null, errors: string[]}}
 */
export function applyStepOps(preset, ops) {
  const errors = [];
  if (!Array.isArray(ops)) return { preset: null, errors: ['ops 必须是数组'] };
  let next = { ...preset, steps: [...(preset?.steps ?? [])] };

  for (const [i, op] of ops.entries()) {
    const at = `ops[${i}]`;
    if (!op || typeof op !== 'object') {
      errors.push(`${at} 必须是对象`);
      continue;
    }
    switch (op.op) {
      case 'reorder': {
        try {
          next = reorderSteps(next, op.order);
        } catch (e) {
          errors.push(`${at} 排序失败：${e.message}`);
        }
        break;
      }
      case 'toggle': {
        const idx = findStepIndex(next, op.entry, op.index ?? 0);
        if (idx < 0) {
          errors.push(`${at} 找不到步骤：${op.entry}`);
          break;
        }
        if (typeof op.enabled !== 'boolean') {
          errors.push(`${at}.enabled 必须是布尔值`);
          break;
        }
        next.steps[idx] = { ...next.steps[idx], enabled: op.enabled };
        break;
      }
      case 'move': {
        const idx = findStepIndex(next, op.entry, op.index ?? 0);
        if (idx < 0) {
          errors.push(`${at} 找不到步骤：${op.entry}`);
          break;
        }
        const delta = Number(op.delta);
        if (!Number.isInteger(delta) || delta === 0) {
          errors.push(`${at}.delta 必须是非零整数`);
          break;
        }
        const target = idx + delta;
        if (target < 0 || target >= next.steps.length) {
          errors.push(`${at} 移动越界：${op.entry} 从 ${idx} 移动到 ${target}`);
          break;
        }
        const moved = next.steps.splice(idx, 1)[0];
        next.steps.splice(target, 0, moved);
        break;
      }
      case 'label': {
        const idx = findStepIndex(next, op.entry, op.index ?? 0);
        if (idx < 0) {
          errors.push(`${at} 找不到步骤：${op.entry}`);
          break;
        }
        const label = op.label === null || op.label === '' ? undefined : String(op.label);
        if (label !== undefined && label.length > 64) {
          errors.push(`${at}.label 超过 64 字`);
          break;
        }
        const step = { ...next.steps[idx] };
        if (label === undefined) delete step.label;
        else step.label = label;
        next.steps[idx] = step;
        break;
      }
      case 'timeout': {
        const idx = findStepIndex(next, op.entry, op.index ?? 0);
        if (idx < 0) {
          errors.push(`${at} 找不到步骤：${op.entry}`);
          break;
        }
        const step = { ...next.steps[idx] };
        if (op.timeoutMs === null || op.timeoutMs === undefined || op.timeoutMs === 0) {
          delete step.timeoutMs;
        } else if (!Number.isInteger(op.timeoutMs) || op.timeoutMs <= 0) {
          errors.push(`${at}.timeoutMs 必须是正整数（或 null 表示清除）`);
          break;
        } else {
          step.timeoutMs = op.timeoutMs;
        }
        next.steps[idx] = step;
        break;
      }
      case 'remove': {
        const idx = findStepIndex(next, op.entry, op.index ?? 0);
        if (idx < 0) {
          errors.push(`${at} 找不到步骤：${op.entry}`);
          break;
        }
        next.steps.splice(idx, 1);
        break;
      }
      case 'add': {
        if (typeof op.entry !== 'string' || !ENTRY_RE.test(op.entry)) {
          errors.push(`${at}.entry 非法：${JSON.stringify(op.entry)}`);
          break;
        }
        next.steps.push({ entry: op.entry, enabled: op.enabled !== false });
        break;
      }
      default:
        errors.push(`${at}.op 不支持：${JSON.stringify(op.op)}`);
    }
  }

  if (errors.length > 0) return { preset: null, errors };
  return { preset: next, errors: [] };
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
