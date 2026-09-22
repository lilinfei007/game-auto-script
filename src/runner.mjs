/**
 * 任务执行层：Tasker 编排、事件发布、失败留证、重试。
 *
 * 失败产物（两种截图各有用途，见 README「失败产物」）：
 *  - debug/on_error/  MaaFramework 在**失败瞬间**保存，文件名带**节点名**（默认开）
 *  - debug/on_error/  本项目在失败后保存，文件名带**任务名**（runtime.saveFailureShot）
 *  - debug/draws/     识别可视化（来自 RecoDetail.draws）
 */
import maa from '@maaxyz/maa-node';
import path from 'node:path';
import { PATHS, ensureDebugDirs } from './config.mjs';
import { saveImage } from './util/image.mjs';
import { screencap } from './controller.mjs';
import { stamp } from './util/log.mjs';
import { registerCleanup } from './lifecycle.mjs';
import * as events from './events.mjs';

/** 会产生 node_id 的上下文消息类别（`<类别>.<阶段>`）。 */
const NODE_KINDS = new Set(['PipelineNode', 'RecognitionNode', 'ActionNode']);

/** 文件名安全化：节点名/任务名会进文件名。 */
function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_');
}

/** 创建并初始化 Tasker。 */
export function createTasker(controller, resource, logger) {
  const tasker = new maa.Tasker();
  tasker.controller = controller;
  tasker.resource = resource;

  if (!tasker.inited) {
    throw new Error('Tasker 初始化失败：请检查 controller / resource 是否有效');
  }
  return tasker;
}

/**
 * 由配置生成 pipeline_override。
 *
 * pipeline JSON 是静态文件，而游戏包名等属于运行期配置，因此用 override 注入，
 * 避免把包名硬编码进流水线。
 */
export function buildPipelineOverride(config) {
  return {
    启动游戏: {
      action: { type: 'StartApp', param: { package: config.game.package } },
    },
  };
}

/** 保存失败留证：截图（按开关）+ 识别可视化。 */
async function saveArtifacts(entry, controller, tasker, recent, runtime, logger) {
  const ts = stamp();
  const safe = safeName(entry);

  if (runtime.saveFailureShot === true) {
    try {
      const shot = await screencap(controller);
      const file = path.join(PATHS.onError, `${ts}_${safe}.png`);
      saveImage(shot.data, file);
      logger.error(`  失败截图（本项目，按任务名）：${file}`);
    } catch (e) {
      logger.error(`  失败截图保存失败：${e.message}`);
    }
  } else if (runtime.saveOnError !== false) {
    logger.error(`  失败截图（框架，失败瞬间，按节点名）：${PATHS.onError}`);
  }

  try {
    let saved = 0;
    for (const item of recent.slice(-6)) {
      const detail = tasker.node_detail(item.nodeId);
      const draws = detail?.reco?.draws ?? [];
      for (let i = 0; i < draws.length; i++) {
        const file = path.join(PATHS.draws, `${ts}_${safe}_${safeName(item.name)}_${i}.png`);
        saveImage(draws[i], file);
        saved++;
      }
    }
    if (saved > 0) logger.error(`  识别可视化：${saved} 张 → ${PATHS.draws}`);
  } catch (e) {
    logger.debug(`  识别可视化保存失败：${e.message}`);
  }
}

/**
 * 执行一串任务入口。
 *
 * @param {object} [options]
 * @param {number} [options.retry=0] 失败后重试次数（每次重试前先跑「回到主界面」）
 * @returns {Promise<{ok:boolean, results:Array<{entry:string, ok:boolean, reason?:string}>}>}
 */
export async function runTasks(
  tasker,
  controller,
  entries,
  config,
  logger,
  pipelineOverride,
  options = {},
) {
  ensureDebugDirs();

  const retry = Math.max(0, Number(options.retry ?? 0) || 0);
  const runtime = config.runtime ?? {};

  /**
   * 每个任务独立的状态，必须在任务开始时清空。
   * 早先 recent 是跨任务累积的，导致第 3 个任务失败时会 dump 出前两个任务的识别可视化。
   */
  let recent = [];
  let currentNode = null;
  let failedNode = null;

  tasker.add_sink((_t, msg) => {
    logger.debug(`[task] ${msg.msg} entry=${msg.entry ?? ''}`);
    events.publishTask({ entry: msg.entry, phase: String(msg.msg ?? ''), uuid: msg.uuid });
  });

  tasker.add_context_sink((_ctx, msg) => {
    const m = String(msg.msg ?? '');
    const dot = m.indexOf('.');
    if (dot < 0) return;
    const kind = m.slice(0, dot);
    const phase = m.slice(dot + 1);
    if (!NODE_KINDS.has(kind)) return;

    if (phase === 'Starting') {
      currentNode = msg.name;
      recent.push({ kind, name: msg.name, nodeId: msg.node_id });
      if (recent.length > 40) recent.shift();
      logger.debug(`  · ${m}: ${msg.name}`);
      events.publishNode({ kind, phase, name: msg.name });
    } else if (phase === 'Failed') {
      failedNode = msg.name;
      logger.debug(`  · ${m}: ${msg.name}`);
      events.publishNode({ kind, phase, name: msg.name });
    }
  });

  // 运行期允许 Ctrl+C：把 tasker.post_stop 注册成收尾动作
  const unregisterStop = registerCleanup(() => {
    try {
      tasker.post_stop().wait();
    } catch {
      /* 忽略 */
    }
  }, '停止任务');

  /** 跑一个入口，返回结果；不负责留证。 */
  /**
   * 单步超时表：入口 → 毫秒。没给就回落到 `runtime.taskTimeoutMs`。
   *
   * 这个能力来自任务集里的 `steps[].timeoutMs`（界面上可以逐个任务设）。
   * 早先 `runTasks` 只把 `taskTimeoutMs` 写死读取，于是界面设的单步超时
   * 传下来也不会生效 —— 接口看着有、实际没用，是最难发现的那类问题。
   */
  const stepTimeouts = options.stepTimeouts ?? {};
  const timeoutFor = (entry) => {
    const own = stepTimeouts[entry];
    if (Number.isInteger(own) && own > 0) return own;
    return config.runtime.taskTimeoutMs;
  };

  const runOne = async (entry) => {
    logger.info(`▶ 开始任务：${entry}`);
    const started = Date.now();
    currentNode = null;
    failedNode = null;
    recent = [];

    const job = tasker.post_task(entry, pipelineOverride).wait();
    const timeoutMs = timeoutFor(entry);
    const ownTimeout = timeoutMs !== config.runtime.taskTimeoutMs;
    if (ownTimeout) {
      logger.debug(`  ${entry} 使用任务集里的单步超时 ${Math.round(timeoutMs / 1000)}s`);
    }

    /**
     * 单一超时源：同一个 timer 既置 `timedOut` 又让竞速落地。
     *
     * 早先这里有两个同延时的 setTimeout（一个置标记、一个让 Promise.race 落地），
     * 它们互相竞争，先触发的那个还可能被 `clearTimeout` 干掉 —— 超时会不会被判成
     * 失败全看调度顺序。现在只有一条路径，行为确定。
     */
    let timedOut = false;
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });

    let ok = false;
    try {
      ok = await Promise.race([job.succeeded, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    if (timedOut && !ok) {
      logger.error(`任务 ${entry} 超时（${Math.round(timeoutMs / 1000)}s），请求停止`);
      try {
        tasker.post_stop().wait();
      } catch {
        /* 忽略 */
      }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (ok) {
      logger.info(`✔ 完成 ${entry}（${elapsed}s）`);
      return { entry, ok: true, elapsed };
    }

    const where = failedNode ?? currentNode;
    const reason = timedOut
      ? `超时 ${Math.round(timeoutMs / 1000)}s（最后节点：${where ?? '未知'}）`
      : where
        ? `任务失败（最后节点：${where}）`
        : '任务失败（没有任何节点被识别：检查任务名是否存在、或当前界面是否在预期位置）';

    logger.error(`✘ 失败 ${entry}（${elapsed}s）：${reason}`);
    return { entry, ok: false, elapsed, reason };
  };

  const results = [];

  /**
   * 运行记录由**调用方**创建。
   *
   * 执行层（runner-web）会带上 preset / trigger 等元信息调用 `events.startRun()`；
   * 只有 CLI 直接调用 runTasks 时才需要在这里兜底建一条。
   *
   * ⚠️ 早先这里无条件 `events.beginRun(entries)`：在执行层已经建过记录的情况下，
   * 它会把那条记录**顶掉**（记成 stopped），另起一条没有 trigger/preset 的空记录
   * （trigger 落到默认的 'manual'）。现象是「一次定时执行变成两条记录、第一条是
   * stopped」，看起来像重复触发，非常难查。
   */
  if (!events.getActiveRun()) {
    events.beginRun(entries);
  } else {
    logger.debug('沿用调用方已创建的运行记录');
  }

  try {
    for (const entry of entries) {
      events.setCurrent(entry);
      let result = await runOne(entry);

      for (let attempt = 1; !result.ok && attempt <= retry; attempt++) {
        logger.warn(`↻ 重试 ${entry}（第 ${attempt}/${retry} 次），先回到主界面`);
        await runOne('回到主界面');
        result = await runOne(entry);
      }

      if (!result.ok) {
        await saveArtifacts(entry, controller, tasker, recent, runtime, logger);
      }

      results.push(result);
      events.addResult(result);
    }
  } finally {
    unregisterStop();
    events.endRun();
  }

  return { ok: results.every((r) => r.ok), results };
}
