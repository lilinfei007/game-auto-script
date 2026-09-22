/**
 * 资源包加载 + 自定义识别/动作注册。
 *
 * 注意注册顺序：必须在 post_bundle 之前或之后都可以，但注册与加载都在同一个
 * Resource 实例上，MaaFramework 执行到 Custom 节点时会在本进程内直接回调。
 *
 * 命名约定（很重要）：
 *   - 文件名负责「人怎么看」：`00_启动游戏.json`、`10_联盟日常.json`
 *   - 节点名负责「框架怎么认」：`启动游戏`、`联盟日常`
 *   两者不一致，所以 `run --tasks 10_联盟日常` 需要 resolveEntry 解析成首个节点。
 *   - 文件名以 `_` 开头的是**共享文件**（如 `_common.json`），不是任务模块，
 *     自动发现时会跳过。
 */
import maa from '@maaxyz/maa-node';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, stripJsonComments } from './config.mjs';
import { registerRecognitions } from './custom/reco.mjs';
import { registerActions } from './custom/action.mjs';

/** 框架两种都收（`entry is not *.json or *.jsonc, skip`）。 */
const PIPELINE_EXT = ['.json', '.jsonc'];

/** 去掉流水线文件的扩展名。 */
export function baseNameOf(file) {
  return file.replace(/\.jsonc?$/, '');
}

/** 列出 pipeline 目录下的流水线文件（按文件名排序，决定自动发现的执行顺序）。 */
export function listPipelineFiles() {
  if (!fs.existsSync(PATHS.pipeline)) return [];
  return fs
    .readdirSync(PATHS.pipeline)
    .filter((f) => PIPELINE_EXT.some((e) => f.endsWith(e)))
    .sort();
}

/** 由基名定位实际文件（.json 优先，其次 .jsonc）；找不到返回 null。 */
export function pipelineFileOf(base) {
  for (const ext of PIPELINE_EXT) {
    const p = path.join(PATHS.pipeline, base + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 读取并解析某个流水线文件。
 * @returns {{ok: true, json: object, nodes: string[]} | {ok: false, error: string}}
 */
export function readPipeline(base) {
  const file = pipelineFileOf(base);
  if (!file) return { ok: false, error: `找不到流水线文件: ${base}.json` };
  try {
    const json = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { ok: false, error: '顶层必须是对象（节点名 → 节点定义）' };
    }
    return { ok: true, json, nodes: Object.keys(json) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 读取某个流水线文件里**第一个节点**的名字（即约定的任务入口）。
 * 解析失败或文件为空时返回 null。
 */
export function firstNodeOf(fileBaseName) {
  const r = readPipeline(fileBaseName);
  return r.ok && r.nodes.length > 0 ? r.nodes[0] : null;
}

/**
 * 自动发现可执行的任务模块（跳过 `_` 开头的共享文件）。
 * @returns {Array<{file: string, base: string, entry: string|null, ok: boolean, error?: string}>}
 */
export function discoverModules() {
  const out = [];
  for (const file of listPipelineFiles()) {
    const base = baseNameOf(file);
    if (base.startsWith('_')) continue;
    const r = readPipeline(base);
    if (!r.ok) {
      out.push({ file, base, entry: null, ok: false, error: r.error });
    } else if (r.nodes.length === 0) {
      out.push({ file, base, entry: null, ok: false, error: '文件里没有任何节点' });
    } else {
      out.push({ file, base, entry: r.nodes[0], ok: true });
    }
  }
  return out;
}

/** 逐个校验所有流水线文件（doctor 用）。 */
export function validatePipelines() {
  return listPipelineFiles().map((file) => {
    const base = baseNameOf(file);
    const r = readPipeline(base);
    return r.ok
      ? { file, base, ok: true, nodes: r.nodes, entry: r.nodes[0] ?? null }
      : { file, base, ok: false, nodes: [], entry: null, error: r.error };
  });
}

/**
 * 把用户给的任务名解析成真实存在的节点名。
 * 已经是节点名则原样返回；否则尝试当作流水线文件名，取其第一个节点。
 */
export function resolveEntry(name, nodes, logger) {
  if (nodes.includes(name)) return name;
  const first = firstNodeOf(name);
  if (first && nodes.includes(first)) {
    logger?.debug(`任务入口 ${name} → 节点 ${first}（取该文件第一个节点）`);
    return first;
  }
  logger?.warn(`任务入口 ${name} 既不是节点名，也不是可解析的流水线文件`);
  return name;
}

/** OCR 模型是否齐备（缺了会报 "Failed to load det or rec"）。 */
export function checkOcrModel() {
  const required = ['det.onnx', 'rec.onnx', 'keys.txt'];
  const missing = required.filter((f) => !fs.existsSync(`${PATHS.ocrModel}/${f}`));
  return { ok: missing.length === 0, missing, dir: PATHS.ocrModel };
}

/**
 * 创建并加载资源。
 * @returns {Promise<{resource: object, nodes: string[]}>}
 */
export async function createResource(config, logger) {
  if (!fs.existsSync(PATHS.resource)) {
    throw new Error(`资源目录不存在: ${PATHS.resource}`);
  }

  const resource = new maa.Resource();
  resource.add_sink((_res, msg) => {
    logger.debug(`[res] ${msg.msg}${msg.path ? ` ${msg.path}` : ''}`);
  });

  registerRecognitions(resource, logger);
  registerActions(resource, logger);

  const job = resource.post_bundle(PATHS.resource).wait();
  if (!(await job.succeeded)) {
    throw new Error(`资源加载失败: ${PATHS.resource}（检查 pipeline JSON 是否合法）`);
  }

  const nodes = resource.node_list ?? [];
  logger.info(
    `资源已加载：${nodes.length} 个节点，自定义识别 ${resource.custom_recognition_list?.length ?? 0} 个、自定义动作 ${resource.custom_action_list?.length ?? 0} 个`,
  );

  return { resource, nodes };
}
