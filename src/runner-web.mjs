/**
 * Web 控制台的执行层：把「连设备 → 建控制器 → 加载资源 → 跑任务」这套流程
 * 收成**唯一入口**，供 HTTP 接口与定时调度器共用。
 *
 * 为什么从 index.mjs 里抽出来：
 *   - 原先这段逻辑写在 `cmdUi` 的闭包里，没法单测，调度器也没法复用；
 *   - 抽出后所有依赖（instance 工厂、resource 工厂）都可注入，
 *     于是「单实例互斥、控制器复用、单步超时透传」这些行为都能用假实现验证。
 *
 * 设计要点：
 *   1. **单实例互斥**：控制器操作全部经一个串行队列。任务运行期间，实时画面、
 *      手动点击、跑单个节点都会被拒绝（返回忙），避免两个操作抢同一个模拟器。
 *   2. **控制器常驻**：实时画面用的控制器在任务结束后**不销毁**，下次运行直接复用，
 *      省掉数秒连接时间；只在使用者停止实时画面时才断开。
 *   3. **假依赖可测**：`isControllerLike` 只检查 `post_connection`，因此测试可以传
 *      一个极简的假控制器。
 */
import { createLogger } from './util/log.mjs';
import { registerCleanup } from './lifecycle.mjs';
import * as events from './events.mjs';
import { applyRuntimeOverrides } from './config.mjs';

/** 判定「这像不像一个 maa 控制器」：只认真正会被用到的方法。 */
export function isControllerLike(obj) {
  return !!obj && typeof obj.post_connection === 'function';
}

/** 判定「这像不像一个 maa 资源对象」。 */
export function isResourceLike(obj) {
  return !!obj && typeof obj.post_bundle === 'function';
}

/**
 * 把入口 + 开关 + 单步超时整理成一次执行计划。
 *
 * @param {object} options
 * @param {string[]} [options.entries] 直接给入口列表（已解析成节点名）
 * @param {Array<{entry:string, enabled?:boolean, timeoutMs?:number}>} [options.steps]
 *        带开关的步骤（`entries` 为空时用）。顺序即执行顺序。
 * @param {Record<string, number>} [options.stepTimeouts] 入口 → 单步超时
 * @returns {{entries: string[], stepTimeouts: Record<string, number>}}
 */
export function buildPlan(options = {}) {
  const stepTimeouts = { ...(options.stepTimeouts ?? {}) };
  let entries = [];

  if (Array.isArray(options.steps) && options.steps.length > 0) {
    for (const s of options.steps) {
      if (!s || typeof s.entry !== 'string' || !s.entry) continue;
      if (s.enabled === false) continue;
      entries.push(s.entry);
      if (Number.isInteger(s.timeoutMs) && s.timeoutMs > 0) stepTimeouts[s.entry] = s.timeoutMs;
    }
  } else if (Array.isArray(options.entries)) {
    entries = options.entries.filter((e) => typeof e === 'string' && e);
  }

  return { entries, stepTimeouts };
}

/**
 * 创建 Web 执行器。
 *
 * @param {object} options
 * @param {object} options.config 当前配置（**会读最新值**，因此传一个 getter 更稳妥）
 * @param {object} options.logger
 * @param {number} [options.defaultInstance]
 * @param {() => object} [options.getConfig] 取最新配置；给了就覆盖 config
 * @param {(index:number)=>Promise<{address:string}>} [options.instanceFactory] 拉起实例
 * @param {(cfg:object, inst:object, logger:object)=>Promise<{controller:object}>} [options.controllerFactory]
 * @param {(cfg:object, logger:object)=>Promise<{resource:object, nodes:string[]}>} [options.resourceFactory]
 * @param {(controller:object, resource:object, logger:object)=>object} [options.taskerFactory]
 * @param {(tasker:object, controller:object, entries:string[], cfg:object, logger:object, override:object, opts:object)=>Promise<{ok:boolean, results:object[]}>} [options.runTasks]
 * @param {(cfg:object)=>object} [options.pipelineOverride]
 * @param {(instance:number, entry:string, timeoutMs:number)=>Promise<{ok:boolean, reason?:string}>} [options.runNodeImpl]
 *        单节点试跑的底层实现（worker/CLI 层注入，因为它需要 maa 细节）
 */
export function createWebRunner(options = {}) {
  const logger = options.logger ?? createLogger('runner-web');
  // 显式判断，避免写成 `typeof getConfig !== 'function'` —— 那样「两个都没给」
  // 也会被当成合法（默认值本身是函数），错误会拖到很久以后才以奇怪的形式爆出来。
  if (!options.getConfig && !options.config) {
    throw new Error('createWebRunner 需要 config 或 getConfig');
  }
  const getConfig = options.getConfig ?? (() => options.config);
  if (typeof getConfig !== 'function') throw new Error('getConfig 必须是函数');

  const defaultInstance = Number.isInteger(options.defaultInstance) ? options.defaultInstance : 0;

  /** 串行队列：所有控制器操作都从这里过，保证不会并发抢设备。 */
  let chain = Promise.resolve();
  function serialize(label, fn) {
    const next = chain.then(fn, fn);
    // 吞掉 rejection 以免污染链条（错误由调用方 via return 值处理）
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next.catch((e) => {
      logger.debug(`${label} 失败：${e.message}`);
      throw e;
    });
  }

  /** 当前任务运行上下文（仅任务运行期间存在）。 */
  let runCtx = null;
  /** 常驻控制器（实时画面用）。 */
  let live = null;
  /** 资源缓存：流水线改动后由 invalidateResource() 丢弃。 */
  let resourceCache = null;

  const cfg = () => getConfig() ?? {};

  async function ensureInstance(index) {
    if (typeof options.instanceFactory !== 'function') {
      throw new Error('未配置 instanceFactory，无法连接设备');
    }
    const ready = await options.instanceFactory(index);
    events.publishDevice({
      ...(events.ext.device ?? {}),
      index,
      ready: true,
      address: ready?.address ?? null,
      detail: 'adb 就绪',
    });
    return ready;
  }

  /** 建立控制器（若已有常驻控制器则复用它）。 */
  async function acquireController(index, { fresh = false } = {}) {
    if (!fresh && live && live.index === index) {
      return { controller: live.controller, reused: true };
    }
    await ensureInstance(index);
    const inst = { index };
    if (typeof options.controllerFactory !== 'function') {
      throw new Error('未配置 controllerFactory，无法建立控制器');
    }
    const { controller } = await options.controllerFactory(cfg(), inst, logger);
    if (!isControllerLike(controller)) throw new Error('controllerFactory 返回的对象不像控制器');
    live = { index, controller };
    events.publishDevice({
      ...(events.ext.device ?? {}),
      index,
      ready: true,
      live: true,
      detail: '控制器已连接',
    });
    return { controller, reused: false };
  }

  /** 加载资源（带缓存，流水线被编辑后可失效）。 */
  async function ensureResource() {
    if (resourceCache) return resourceCache;
    if (typeof options.resourceFactory !== 'function') {
      throw new Error('未配置 resourceFactory，无法加载资源');
    }
    const { resource, nodes } = await options.resourceFactory(cfg(), logger);
    if (!isResourceLike(resource)) throw new Error('resourceFactory 返回的对象不像资源');
    resourceCache = { resource, nodes: nodes ?? [] };
    return resourceCache;
  }

  async function ensureTasker(controller, resource) {
    if (typeof options.taskerFactory !== 'function') {
      throw new Error('未配置 taskerFactory，无法创建 Tasker');
    }
    const tasker = options.taskerFactory(controller, resource, logger);
    if (!tasker || typeof tasker.post_task !== 'function') {
      throw new Error('taskerFactory 返回的对象不像 Tasker');
    }
    return tasker;
  }

  /** 生成 pipeline_override（默认实现是空对象，真实实现注入）。 */
  const overrideFor = (config, opts) =>
    typeof options.pipelineOverride === 'function' ? options.pipelineOverride(config, opts) : {};

  const runTasksImpl = options.runTasks;

  /**
   * 真正执行一次：只负责「拿控制器 → 跑 → 交回结果」，不加锁。
   * 由 start() 在锁内调用。
   */
  async function execute(plan, meta) {
    const index = meta.instance;
    const { config: effConfig, rejected } = applyRuntimeOverrides(cfg(), meta.runtime);
    for (const r of rejected) logger.warn(`忽略无法识别的运行时参数 ${r.key}：${r.reason}`);

    const { controller } = await acquireController(index);
    const { resource } = await ensureResource();
    const tasker = await ensureTasker(controller, resource);
    runCtx = { tasker, controller, index };

    // 设备与资源都就绪了：通知调用方把阶段从 starting 切到 running。
    // 没有这个回调，界面会在整个运行期间显示「正在准备」（早先踩过）。
    meta.onReady?.();

    logger.info(
      `开始执行：实例 ${index}，${plan.entries.length} 个任务` +
        (meta.presetName ? `（任务集「${meta.presetName}」）` : ''),
    );

    try {
      if (typeof runTasksImpl !== 'function') {
        throw new Error('未配置 runTasks 实现');
      }
      return await runTasksImpl(
        tasker,
        controller,
        plan.entries,
        effConfig,
        logger,
        overrideFor(effConfig, meta),
        { retry: meta.retry ?? 0, stepTimeouts: plan.stepTimeouts, preset: meta.preset ?? null },
      );
    } finally {
      runCtx = null;
    }
  }

  const runner = {
    // ---------------------------------------------------------- 状态

    getRunState: () => events.buildRunState(),

    /** 是否正忙（任务运行，或准备阶段）。 */
    isBusy: () => events.ext.phase !== 'idle' || events.isRunning(),

    /** 阶段：idle / starting / running / stopping。 */
    getPhase: () => events.ext.phase,

    getDeviceState: () => events.ext.device,

    /** 设备是否可用（有常驻控制器就算可用）。 */
    hasLiveController: () => !!live,

    // ---------------------------------------------------------- 执行

    /**
     * 开始一次运行。**必须在事件层先进入 starting**（由调用方负责），
     * 这样「连设备要好几秒」的窗口里第二次请求会被拦下。
     *
     * @param {object} opts
     * @param {string[]} [opts.entries] 入口列表（已解析）
     * @param {Array} [opts.steps] 带开关的步骤
     * @param {number} [opts.instance]
     * @param {number} [opts.retry]
     * @param {object} [opts.runtime] 运行时参数覆盖
     * @param {string} [opts.preset] 任务集 id
     * @param {string} [opts.presetName]
     * @param {'manual'|'schedule'} [opts.trigger]
     * @param {() => void} [opts.onReady] 设备就绪、即将开跑时回调
     */
    async start(opts = {}) {
      const plan = buildPlan(opts);
      if (plan.entries.length === 0) throw new Error('没有要执行的任务（任务集为空或全部关闭）');

      const index = Number.isInteger(opts.instance) ? opts.instance : defaultInstance;
      const meta = {
        instance: index,
        retry: Math.max(0, Number(opts.retry ?? 0) || 0),
        runtime: opts.runtime,
        preset: opts.preset ?? null,
        presetName: opts.presetName ?? null,
        trigger: opts.trigger ?? 'manual',
      };

      return serialize('run', async () => {
        events.startRun(plan.entries, {
          preset: meta.preset,
          presetName: meta.presetName,
          trigger: meta.trigger,
          instance: index,
        });
        try {
          const result = await execute(plan, { ...meta, onReady: opts.onReady });
          const failed = !result?.ok;
          events.finishRun(failed ? 'failed' : 'ok');
          return result;
        } catch (e) {
          events.finishRun('failed', e.message);
          throw e;
        }
      });
    },

    /** 停止当前任务（中断 Tasker）。 */
    async stop() {
      const ctx = runCtx;
      if (!ctx?.tasker) {
        logger.warn('没有正在运行的任务可停止');
        return false;
      }
      logger.info('正在停止当前任务');
      await ctx.tasker.post_stop().wait();
      return true;
    },

    /**
     * 跑单个节点（调试用）：不算一次完整运行，但同样占用控制器锁，
     * 因此不会和正在运行的任务打架。
     *
     * @param {string} node 节点名
     * @param {object} [opts] `{instance, timeoutMs}`
     */
    async runNode(node, opts = {}) {
      if (typeof node !== 'string' || !node) throw new Error('缺少节点名');
      if (typeof options.runNodeImpl !== 'function') {
        throw new Error('未配置单节点试跑实现');
      }
      const index = Number.isInteger(opts.instance) ? opts.instance : defaultInstance;
      return serialize('runNode', async () => {
        await acquireController(index);
        const { resource, nodes } = await ensureResource();
        if (!nodes.includes(node)) throw new Error(`资源里没有节点：${node}`);
        const timeoutMs =
          Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0
            ? opts.timeoutMs
            : (cfg().runtime?.taskTimeoutMs ?? 600000);
        logger.info(`单节点试跑：${node}（超时 ${Math.round(timeoutMs / 1000)}s）`);
        return options.runNodeImpl(index, node, timeoutMs);
      });
    },

    // ---------------------------------------------------------- 实时画面

    /**
     * 打开实时画面：建立（或复用）常驻控制器。
     * 任务运行期间返回忙，避免抢设备。
     */
    async startLive(opts = {}) {
      const index = Number.isInteger(opts.instance) ? opts.instance : defaultInstance;
      if (events.ext.phase !== 'idle') throw new Error('任务运行期间不能打开实时画面');
      return serialize('startLive', () => acquireController(index));
    },

    /** 关闭实时画面并断开控制器。 */
    async stopLive() {
      // maa 的控制器没有显式销毁接口（置空后由 GC 回收），
      // 这里只解除「常驻」标记并广播设备状态。
      live = null;
      events.publishDevice({ ...(events.ext.device ?? {}), live: false, detail: '已断开实时画面' });
      return true;
    },

    /** 截一张图（实时画面用）。 */
    async shot(opts = {}) {
      const index = Number.isInteger(opts.instance) ? opts.instance : defaultInstance;
      if (typeof options.screencap !== 'function') throw new Error('未配置截图实现');
      return serialize('shot', async () => {
        const { controller } = await acquireController(index);
        const data = await options.screencap(controller);
        events.publishDevice({ ...(events.ext.device ?? {}), index, ready: true, live: true, detail: '画面已连接' });
        return data;
      });
    },

    // ---------------------------------------------------------- 手动操作

    /** 手动点击。任务运行期间拒绝。 */
    async tap(x, y, opts = {}) {
      if (typeof options.tapImpl !== 'function') throw new Error('未配置点击实现');
      if (events.ext.phase !== 'idle') throw new Error('任务运行期间不能手动操作');
      const index = Number.isInteger(opts.instance) ? opts.instance : defaultInstance;
      return serialize('tap', async () => {
        const { controller } = await acquireController(index);
        return options.tapImpl(controller, Math.round(x), Math.round(y));
      });
    },

    /** 手动滑动。任务运行期间拒绝。 */
    async swipe(from, to, durationMs = 300, opts = {}) {
      if (typeof options.swipeImpl !== 'function') throw new Error('未配置滑动实现');
      if (events.ext.phase !== 'idle') throw new Error('任务运行期间不能手动操作');
      const index = Number.isInteger(opts.instance) ? opts.instance : defaultInstance;
      return serialize('swipe', async () => {
        const { controller } = await acquireController(index);
        return options.swipeImpl(controller, from, to, durationMs);
      });
    },

    // ---------------------------------------------------------- 维护

    /** 流水线被编辑后调用：下次执行重新加载资源。 */
    invalidateResource() {
      resourceCache = null;
      logger.debug('资源缓存已失效，下次执行将重新加载流水线');
    },

    /** 供诊断：当前是否已加载资源。 */
    getResourceInfo: () => (resourceCache ? { nodes: [...resourceCache.nodes] } : null),

    /** 注册进程收尾：断开控制器、停止任务。 */
    installCleanup() {
      const unregister = registerCleanup(async () => {
        try {
          if (runCtx?.tasker) await runCtx.tasker.post_stop().wait();
        } catch {
          /* 收尾失败不阻塞退出 */
        }
        live = null;
      }, '停止任务并断开设备');
      return unregister;
    },
  };

  return runner;
}
