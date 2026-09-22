/**
 * 流水线的读取、校验与安全写入（供 Web 界面的「编辑 pipeline」用）。
 *
 * 字段白名单与类型**以 v5.13.1 官方协议为准**，来源是
 * `docs/reference/3.1-任务流水线协议.md`（由 `node tools/fetch-assets.mjs --docs` 拉取，
 * 该文件不入库）。协议要点：
 *   - Pipeline v2：`recognition` / `action` 是 `{ type, param }` 二级结构；
 *     v1 的扁平写法（`"recognition": "OCR"`）框架仍然兼容，本模块两种都接受。
 *   - `timeout` 是**当前节点 next 列表**的识别等待时间，不是自己 recognition 的等待时间
 *     （这条最容易写错，校验时专门提醒）。
 *   - 节点属性（`[JumpBack]` / `[Anchor]`）写在 `next` / `on_error` 的名字里，
 *     不这样剥掉前缀就查不到节点，会把正确的引用误报成「节点不存在」。
 *
 * 安全约定：
 *   - 只能改 `resource/pipeline/` 下**已存在**的 .json/.jsonc；
 *     base 白名单正则不允许 `.` 与路径分隔符，配合 path.resolve 复核，从根上杜绝穿越。
 *   - 保存前必须通过校验（有 error 就拒绝），并备份旧文件。
 */
import fs from 'node:fs';
import path from 'node:path';

import { PATHS } from './config.mjs';
import { backupFile, writeFileAtomic } from './util/fsx.mjs';
import {
  pipelineFileOf,
  baseNameOf,
  listPipelineFiles,
  readPipeline,
  validatePipelines,
} from './resource.mjs';

/** 文件名白名单：只允许中英文、数字、下划线、连字符。刻意不含 `.` 与路径分隔符。 */
export const PIPELINE_BASE_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{1,64}$/;

/** 识别算法类型（协议「算法类型」一节）。 */
export const RECOGNITION_TYPES = new Set([
  'DirectHit',
  'TemplateMatch',
  'FeatureMatch',
  'ColorMatch',
  'OCR',
  'NeuralNetworkClassify',
  'NeuralNetworkDetect',
  'And',
  'Or',
  'Custom',
]);

/** 动作类型（协议「动作类型」一节）。 */
export const ACTION_TYPES = new Set([
  'DoNothing',
  'Click',
  'LongPress',
  'Swipe',
  'MultiSwipe',
  'Scroll',
  'TouchDown',
  'TouchMove',
  'TouchUp',
  'ClickKey',
  'LongPressKey',
  'KeyDown',
  'KeyUp',
  'InputText',
  'StartApp',
  'StopApp',
  'StopTask',
  'Command',
  'Shell',
  'Screencap',
  'Custom',
]);

/** 节点级字段 → 类型。协议「属性字段 / Pipeline v1」一节。 */
const NODE_FIELDS = {
  recognition: 'recognition',
  action: 'action',
  next: 'nodeList',
  on_error: 'nodeList',
  timeout: 'int', // 允许 -1（无限等待，v5.5）
  rate_limit: 'uint',
  anchor: 'anchor',
  inverse: 'bool',
  enabled: 'bool',
  max_hit: 'uint',
  pre_delay: 'uint',
  post_delay: 'uint',
  pre_wait_freezes: 'uintOrObject',
  post_wait_freezes: 'uintOrObject',
  repeat: 'uint',
  repeat_delay: 'uint',
  repeat_wait_freezes: 'uintOrObject',
  focus: 'object',
  attach: 'object',
  // v1 时代字段：框架仍接受，但已废弃
  is_sub: 'deprecated',
  interrupt: 'deprecated',
};

/** 只校验「是不是对象」的 param 字段里，明确需要特定形状的几个。 */
const PARAM_SHAPES = {
  roi: 'rect',
  roi_offset: 'rect',
  target_offset: 'rect',
  order_by: 'string',
  expected: 'regex',
  template: 'string',
  threshold: 'number',
  max_hit: 'uint',
  package: 'string',
  key: 'int',
  text: 'string',
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isUint = (v) => Number.isInteger(v) && v >= 0;
const isInt = (v) => Number.isInteger(v);

/**
 * 剥掉节点属性前缀，拿到真实节点名。
 * `[JumpBack]通用弹窗处理` → `通用弹窗处理`
 * `[Anchor]我的锚点` → `我的锚点`（锚点不是节点名，调用方据返回值自行判断）
 */
export function stripRefDecorators(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/^\[[A-Za-z]+\]/, '').trim();
}

/** 取出引用里的属性前缀（无前缀返回空串）。 */
export function refDecoratorOf(name) {
  if (typeof name !== 'string') return '';
  const m = name.match(/^\[([A-Za-z]+)\]/);
  return m ? m[1] : '';
}

/** 把 `next` / `on_error` 规范化成 `[{ raw, name, decorator }]`。 */
export function normalizeRefs(value) {
  const list = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ raw: item, name: stripRefDecorators(item), decorator: refDecoratorOf(item), form: 'string' });
    } else if (isPlainObject(item)) {
      // v5.1 起支持 NodeAttr 对象形式：{ name: "[JumpBack]X" } 或 { target: ... }
      const raw = typeof item.name === 'string' ? item.name : '';
      out.push({ raw, name: stripRefDecorators(raw), decorator: refDecoratorOf(raw), form: 'object' });
    } else {
      out.push({ raw: String(item), name: '', decorator: '', form: 'invalid' });
    }
  }
  return out;
}

/**
 * 校验一份流水线文档。
 *
 * @param {object} json 已解析的流水线（节点名 → 节点定义）
 * @param {object} [options]
 * @param {string[]} [options.knownNodes] 全仓库存在的节点名；给了就校验引用完整性。
 *        **注意参数名统一叫 knownNodes**（早先这里叫 allNodes，而 writePipelineDoc
 *        传的是 knownNodes，名字对不上导致保存时的引用校验被静默跳过，
 *        坏引用照样落盘 —— 校验形同虚设，这类 bug 最难发现）。
 * @param {string[]} [options.customRecognitions] 已注册的自定义识别名
 * @param {string[]} [options.customActions] 已注册的自定义动作名
 * @returns {{errors: Array<{path:string,message:string}>, warnings: Array<{path:string,message:string}>}}
 */
export function validatePipelineDoc(json, options = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!isPlainObject(json)) {
    err('', '顶层必须是对象（节点名 → 节点定义）');
    return { errors, warnings };
  }
  const names = Object.keys(json);
  if (names.length === 0) warn('', '这个文件里没有任何节点');

  const allNodes = Array.isArray(options.knownNodes) ? new Set(options.knownNodes) : null;
  if (!allNodes) {
    // 没给全仓库节点表就无法判断引用是否存在。明确说清楚，避免「以为校验过了」。
    warn('', '未提供全仓库节点表（knownNodes），本次跳过引用完整性校验');
  }
  // 先收集本文件的锚点定义，供 [Anchor] 引用判断
  const anchors = new Set();
  for (const [name, node] of Object.entries(json)) {
    if (!isPlainObject(node)) continue;
    const a = node.anchor;
    if (typeof a === 'string') anchors.add(a);
    else if (Array.isArray(a)) for (const x of a) if (typeof x === 'string') anchors.add(x);
    else if (isPlainObject(a)) for (const k of Object.keys(a)) anchors.add(k);
    if (name.startsWith('$')) warn(name, '以 $ 开头的节点名不会被框架解析（协议明确跳过）');
  }

  for (const [name, node] of Object.entries(json)) {
    const at = name;
    if (!name.trim()) {
      err(at, '节点名不能为空');
      continue;
    }
    if (/[\s]/.test(name)) warn(at, '节点名里有空白字符，容易在引用时写错');
    if (!isPlainObject(node)) {
      err(at, '节点定义必须是对象');
      continue;
    }

    for (const [field, value] of Object.entries(node)) {
      const kind = NODE_FIELDS[field];
      if (!kind) {
        // 允许 $ 开头的自定义字段
        if (field.startsWith('$')) continue;
        warn(`${at}.${field}`, `未知字段（协议里没有 "${field}"），框架会忽略它`);
        continue;
      }
      if (kind === 'deprecated') {
        warn(`${at}.${field}`, `"${field}" 已废弃，建议改用节点属性 [JumpBack]`);
        continue;
      }
      checkField(kind, value, `${at}.${field}`, { err, warn, json, anchors, allNodes });

      if (field === 'recognition' || field === 'action') {
        checkRecoOrAction(field, value, `${at}.${field}`, { err, warn, options });
      }
    }

    // 引用完整性
    for (const field of ['next', 'on_error']) {
      for (const ref of normalizeRefs(node[field])) {
        const fieldAt = `${at}.${field}`;
        if (ref.form === 'invalid') {
          err(fieldAt, `只接受字符串或 { name } 对象，收到 ${JSON.stringify(ref.raw)}`);
          continue;
        }
        if (!ref.name) {
          err(fieldAt, '引用的节点名为空');
          continue;
        }
        if (ref.decorator === 'Anchor') {
          if (anchors.size === 0) {
            warn(fieldAt, `引用了锚点 [Anchor]${ref.name}，但本文件里没有任何 anchor 定义`);
          }
          continue;
        }
        if (allNodes && !allNodes.has(ref.name)) {
          err(fieldAt, `引用的节点不存在：${ref.name}${ref.decorator ? `（原始写法 ${ref.raw}）` : ''}`);
        }
      }
    }

    // timeout 是最容易理解错的字段，写错了很难查
    if (node.timeout !== undefined && node.timeout >= 0 && node.timeout < 200) {
      warn(`${at}.timeout`, `timeout=${node.timeout}ms 很短；注意它是「本节点 next 列表的识别等待」，不是自己 recognition 的等待时间`);
    }
  }

  return { errors, warnings };
}

/** 按种类校验单个字段。 */
function checkField(kind, value, at, ctx) {
  const { err, warn, json, allNodes } = ctx;
  switch (kind) {
    case 'recognition':
    case 'action':
      if (typeof value === 'string') {
        // v1 扁平写法：框架兼容，提醒一下风格
        warn(at, `用的是 v1 扁平写法（"${value}"），建议改成 { "type": "${value}", "param": {} }`);
        return;
      }
      if (!isPlainObject(value)) err(at, '必须是对象 { type, param } 或字符串');
      return;
    case 'nodeList': {
      if (value === undefined) return;
      if (typeof value !== 'string' && !Array.isArray(value)) {
        err(at, '必须是字符串或字符串数组');
        return;
      }
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        if (typeof item !== 'string' && !isPlainObject(item)) {
          err(at, `列表项必须是字符串或 { name } 对象，收到 ${JSON.stringify(item)}`);
        }
      }
      return;
    }
    case 'int':
      if (!isInt(value)) err(at, `必须是整数，收到 ${JSON.stringify(value)}`);
      return;
    case 'uint':
      if (!isUint(value)) err(at, `必须是非负整数，收到 ${JSON.stringify(value)}`);
      return;
    case 'bool':
      if (typeof value !== 'boolean') err(at, `必须是布尔值，收到 ${JSON.stringify(value)}`);
      return;
    case 'object':
      if (!isPlainObject(value)) err(at, `必须是对象，收到 ${JSON.stringify(value)}`);
      return;
    case 'uintOrObject':
      if (!isUint(value) && !isPlainObject(value)) {
        err(at, `必须是非负整数或对象，收到 ${JSON.stringify(value)}`);
      }
      return;
    case 'anchor':
      if (typeof value === 'string' || Array.isArray(value) || isPlainObject(value)) return;
      err(at, `必须是字符串 / 字符串数组 / 对象，收到 ${JSON.stringify(value)}`);
      return;
    default:
      return;
  }
}

/** 校验 recognition / action 的 type 与 param。 */
function checkRecoOrAction(field, value, at, ctx) {
  const { err, warn, options } = ctx;
  if (typeof value === 'string') return; // v1 写法已在 checkField 里提醒
  if (!isPlainObject(value)) return;

  const type = value.type;
  const known = field === 'recognition' ? RECOGNITION_TYPES : ACTION_TYPES;
  if (type !== undefined) {
    if (typeof type !== 'string') err(`${at}.type`, 'type 必须是字符串');
    else if (!known.has(type)) {
      err(`${at}.type`, `未知的${field === 'recognition' ? '识别' : '动作'}类型：${type}（可用：${[...known].join(', ')}）`);
    }
  }

  const param = value.param;
  if (param !== undefined && !isPlainObject(param)) {
    err(`${at}.param`, 'param 必须是对象');
    return;
  }
  if (!isPlainObject(param)) return;

  for (const [key, v] of Object.entries(param)) {
    const shape = PARAM_SHAPES[key];
    if (!shape) continue; // param 里字段很多且随算法而异，未列出的不判类型
    if (shape === 'rect') {
      if (!Array.isArray(v) || v.length !== 4 || !v.every(isInt)) {
        err(`${at}.param.${key}`, `必须是 4 个整数（协议 v5.6 起允许负数），收到 ${JSON.stringify(v)}`);
      }
    } else if (shape === 'regex') {
      if (typeof v !== 'string') err(`${at}.param.${key}`, '必须是字符串正则');
      else {
        try {
          new RegExp(v);
        } catch (e) {
          err(`${at}.param.${key}`, `正则无法编译：${e.message}`);
        }
      }
    } else if (shape === 'string') {
      if (typeof v !== 'string') err(`${at}.param.${key}`, '必须是字符串');
    } else if (shape === 'number') {
      if (typeof v !== 'number' || Number.isNaN(v)) err(`${at}.param.${key}`, '必须是数字');
    } else if (shape === 'uint') {
      if (!isUint(v)) err(`${at}.param.${key}`, '必须是非负整数');
    } else if (shape === 'int') {
      if (!isInt(v)) err(`${at}.param.${key}`, '必须是整数');
    }
  }

  // 自定义识别/动作必须给出名字
  if (field === 'recognition' && type === 'Custom' && typeof param.custom_recognition !== 'string') {
    err(`${at}.param.custom_recognition`, 'Custom 识别必须指定 custom_recognition');
  }
  if (field === 'action' && type === 'Custom' && typeof param.custom_action !== 'string') {
    err(`${at}.param.custom_action`, 'Custom 动作必须指定 custom_action');
  }

  // 名字拼错是常见问题：只警告，不拦（注册表可能来自别的 bundle）
  if (field === 'recognition' && typeof param.custom_recognition === 'string') {
    const known = options.customRecognitions;
    if (Array.isArray(known) && known.length > 0 && !known.includes(param.custom_recognition)) {
      warn(
        `${at}.param.custom_recognition`,
        `本项目没有注册名为 "${param.custom_recognition}" 的自定义识别（已注册：${known.join(', ')}）`,
      );
    }
  }
  if (field === 'action' && typeof param.custom_action === 'string') {
    const known = options.customActions;
    if (Array.isArray(known) && known.length > 0 && !known.includes(param.custom_action)) {
      warn(
        `${at}.param.custom_action`,
        `本项目没有注册名为 "${param.custom_action}" 的自定义动作（已注册：${known.join(', ')}）`,
      );
    }
  }

  // 运行期会被 override 的占位符：提示而不是报错
  if (param.package === 'TODO_SET_ME') {
    warn(
      `${at}.param.package`,
      '包名是占位符，运行期由 pipeline_override 注入 config.game.package —— 这是刻意保留的写法',
    );
  }
}

// ---------------------------------------------------------------- 读取与索引

/** 全部流水线文件的概览（界面左侧列表用）。 */
export function listPipelineDocs() {
  return validatePipelines().map((p) => ({
    base: p.base,
    file: p.file,
    shared: p.base.startsWith('_'),
    ok: p.ok,
    entry: p.entry,
    nodes: p.nodes,
    error: p.error ?? null,
  }));
}

/** 全仓库节点索引：节点名 → 来自哪个文件；以及被谁引用。 */
export function buildNodeIndex() {
  const byNode = new Map();
  const docs = listPipelineDocs();

  for (const doc of docs) {
    if (!doc.ok) continue;
    for (const node of doc.nodes) {
      const prev = byNode.get(node);
      if (prev) {
        // 同名节点在多个文件里定义：框架按加载顺序覆盖，这里如实报告
        prev.duplicatedIn.push(doc.base);
      } else {
        byNode.set(node, { node, base: doc.base, duplicatedIn: [], referencedBy: [] });
      }
    }
  }

  for (const doc of docs) {
    if (!doc.ok) continue;
    const r = readPipeline(doc.base);
    if (!r.ok) continue;
    for (const [nodeName, node] of Object.entries(r.json)) {
      if (!isPlainObject(node)) continue;
      for (const field of ['next', 'on_error']) {
        for (const ref of normalizeRefs(node[field])) {
          if (!ref.name || ref.decorator === 'Anchor') continue;
          const target = byNode.get(ref.name);
          if (target) target.referencedBy.push({ base: doc.base, node: nodeName, field });
        }
      }
    }
  }

  const nodes = [...byNode.values()];
  return { nodes, total: nodes.length };
}

/** 读取单个流水线文件。文件不存在返回 null。 */
export function readPipelineDoc(base) {
  const file = pipelineFileOf(base);
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  const parsed = readPipeline(base);
  return {
    base,
    file,
    text,
    mtime,
    ext: path.extname(file),
    ok: parsed.ok,
    json: parsed.ok ? parsed.json : null,
    nodes: parsed.ok ? parsed.nodes : [],
    error: parsed.ok ? null : parsed.error,
  };
}

/** 校验调用方给的 base 是否可写，返回绝对路径或抛错。 */
export function resolveWritablePipeline(base) {
  if (typeof base !== 'string' || !PIPELINE_BASE_RE.test(base)) {
    throw new Error(
      `流水线名非法：${JSON.stringify(base)}（只允许中英文、数字、下划线、连字符，最长 64 位）`,
    );
  }
  const file = pipelineFileOf(base);
  if (!file) throw new Error(`流水线文件不存在：${base}.json / ${base}.jsonc（本接口只改已有文件）`);

  // 双保险：即便白名单被绕过，也要求最终路径仍在 pipeline 目录内
  const dir = path.resolve(PATHS.pipeline);
  const target = path.resolve(file);
  if (target !== path.join(dir, path.basename(target)) || !target.startsWith(dir + path.sep)) {
    throw new Error(`拒绝写入 pipeline 目录之外的路径：${target}`);
  }
  return { file, target, dir };
}

/**
 * 写回一份流水线。
 *
 * @param {string} base 文件基名（不含扩展名）
 * @param {string} text 新的文件内容（必须是合法 JSON；JSONC 注释会丢）
 * @param {object} [options]
 * @param {number} [options.expectedMtime] 期望的旧 mtime；不一致则拒绝（防止覆盖外部编辑）
 * @param {string[]} [options.knownNodes] 全仓库节点名（**必须传**，否则引用校验会跳过）
 * @param {string[]} [options.customRecognitions]
 * @param {string[]} [options.customActions]
 * @returns {{file:string, backup:string|null, warnings:Array, nodes:string[]}}
 */
export function writePipelineDoc(base, text, options = {}) {
  const { target } = resolveWritablePipeline(base);

  if (options.expectedMtime !== undefined && options.expectedMtime !== null) {
    const actual = fs.existsSync(target) ? fs.statSync(target).mtimeMs : null;
    if (actual !== null && Math.abs(actual - options.expectedMtime) > 1) {
      throw new Error('文件已被外部修改，请重新加载后再保存（避免覆盖你在编辑器里的改动）');
    }
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`不是合法 JSON：${e.message}`);
  }

  const { errors, warnings: rawWarnings } = validatePipelineDoc(json, options);
  if (errors.length > 0) {
    const detail = errors.slice(0, 8).map((e) => `${e.path || '(顶层)'}：${e.message}`).join('；');
    const more = errors.length > 8 ? `（另有 ${errors.length - 8} 处）` : '';
    throw new Error(`校验未通过：${detail}${more}`);
  }

  const warnings = [...rawWarnings];
  // 保存 JSON 一定会丢注释：先说清楚，别让使用者以为注释还在
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (/\/\/|\/\*/.test(original)) {
    warnings.push({ path: '', message: '原文件里有注释，保存后会丢失（原文件已自动备份）' });
  }

  // 用本项目的手写风格落盘：短数字数组保持一行，避免保存一次就把整个文件重排
  const formatted = `${formatPipelineJson(json)}\n`;
  if (original.trim() && formatted.trim() !== original.trim()) {
    warnings.push({
      path: '',
      message: '文件已按标准风格重新格式化（空行与手写对齐会变化，内容不变）',
    });
  }

  const backup = backupFile(target, PATHS.pipelineBackups);
  writeFileAtomic(target, formatted);
  return { file: target, backup, warnings, nodes: Object.keys(json) };
}

/** 汇总：给界面左侧列表用的引用统计。 */
export function pipelineStats() {
  const index = buildNodeIndex();
  const docs = listPipelineDocs().map((d) => ({
    ...d,
    refCount: index.nodes
      .filter((n) => n.base === d.base)
      .reduce((sum, n) => sum + n.referencedBy.length, 0),
  }));
  const orphans = index.nodes.filter((n) => n.referencedBy.length === 0).map((n) => `${n.base}:${n.node}`);
  return { docs, totalNodes: index.total, orphans };
}

/**
 * 按本项目手写流水线的风格序列化 JSON。
 *
 * 为什么要自己写而不是直接 `JSON.stringify(obj, null, 2)`：
 * 后者会把 `"roi": [0, 0, 0, 0]` 展开成四行，而人写流水线时坐标/阈值数组都是
 * 一行的。保存一次就把整个文件重排，git diff 会变成几百行噪音，
 * 真正的改动反而看不出来。
 *
 * 规则：
 *   - 短数字数组（长度 ≤ 6 且全是 number）压成一行
 *   - 其余保持 2 空格缩进
 *   - 边界情况（例如元素本身是对象）退回标准序列化，保证输出始终合法
 */
export function formatPipelineJson(json) {
  return stringifyStyled(json, 0);
}

const INLINE_ARRAY_MAX = 6;

function stringifyStyled(value, depth) {
  const pad = '  '.repeat(depth);
  const padInner = '  '.repeat(depth + 1);

  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inline = value.length <= INLINE_ARRAY_MAX && value.every((v) => typeof v === 'number');
    if (inline) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    const items = value.map((v) => `${padInner}${stringifyStyled(v, depth + 1)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  const entries = keys.map(
    (k) => `${padInner}${JSON.stringify(k)}: ${stringifyStyled(value[k], depth + 1)}`,
  );
  return `{\n${entries.join(',\n')}\n${pad}}`;
}

export { listPipelineFiles, baseNameOf };
