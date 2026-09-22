import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebRunner, buildPlan, isControllerLike, isResourceLike } from '../src/runner-web.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import * as events from '../src/events.mjs';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假控制器：只需要 post_connection 就算「像控制器」。 */
function fakeController() {
  return {
    post_connection: () => ({ wait: () => ({ succeeded: Promise.resolve(true) }) }),
    calls: [],
  };
}

/** 记录调用的假环境。 */
function makeEnv(overrides = {}) {
  const log = { instances: 0, controller: 0, resource: 0, tasker: 0, runs: [], taps: [], swipes: [], shots: 0, nodeRuns: [] };
  const env = {
    log,
    instanceFactory: async (index) => {
      log.instances++;
      return { address: `127.0.0.1:${16384 + 32 * index}` };
    },
    controllerFactory: async () => {
      log.controller++;
      return { controller: fakeController() };
    },
    resourceFactory: async () => {
      log.resource++;
      return { resource: { post_bundle: () => {} }, nodes: ['启动游戏', '联盟日常', '回到主界面'] };
    },
    taskerFactory: () => {
      log.tasker++;
      return { post_task: () => {}, post_stop: () => ({ wait: async () => {} }) };
    },
    runTasks: async (tasker, controller, entries, cfg, logger, override, opts) => {
      log.runs.push({ entries: [...entries], opts: { ...opts }, runtime: cfg.runtime });
      // 真实 runTasks 会通过事件层登记每个任务的结果，这里如实模拟，
      // 否则 run 记录里的 results 恒为空，测不出「结果被正确登记」。
      const results = entries.map((e) => ({ entry: e, ok: true }));
      for (const r of results) events.addResult(r);
      return { ok: true, results };
    },
    runNodeImpl: async (index, node, timeoutMs) => {
      log.nodeRuns.push({ index, node, timeoutMs });
      return { ok: true };
    },
    screencap: async () => {
      log.shots++;
      return Buffer.from('png');
    },
    tapImpl: async (controller, x, y) => {
      log.taps.push([x, y]);
      return true;
    },
    swipeImpl: async (controller, from, to, d) => {
      log.swipes.push([from, to, d]);
      return true;
    },
    pipelineOverride: () => ({ 启动游戏: { action: { type: 'StartApp' } } }),
    ...overrides,
  };
  return env;
}

function makeRunner(envOverrides = {}, runnerOverrides = {}) {
  events.resetForTest();
  const env = makeEnv(envOverrides);
  assert.ok(env && typeof env === 'object', `makeEnv 应当返回对象，实际是 ${typeof env}`);
  // 注意：要把 env 里的**工厂函数**摊开传给 runner，只把 log 单独留出来做断言
  const { log, ...factories } = env;
  const runner = createWebRunner({
    config: structuredClone(DEFAULT_CONFIG),
    logger: silent,
    defaultInstance: 0,
    ...factories,
    ...runnerOverrides,
  });
  return { runner, env: log };
}

// ------------------------------------------------------------ 纯函数

test('isControllerLike / isResourceLike: 认对象形态', () => {
  assert.equal(isControllerLike(fakeController()), true);
  assert.equal(isControllerLike({}), false);
  assert.equal(isControllerLike(null), false);
  assert.equal(isResourceLike({ post_bundle: () => {} }), true);
  assert.equal(isResourceLike({}), false);
});

test('buildPlan: steps 决定顺序，关闭的被跳过，单步超时被收集', () => {
  const plan = buildPlan({
    steps: [
      { entry: 'a', enabled: true, timeoutMs: 1000 },
      { entry: 'b', enabled: false },
      { entry: 'c' },
      { entry: 'd', enabled: true },
    ],
  });
  assert.deepEqual(plan.entries, ['a', 'c', 'd']);
  assert.deepEqual(plan.stepTimeouts, { a: 1000 });
});

test('buildPlan: 没有 steps 时用 entries；非法项被过滤', () => {
  const plan = buildPlan({ entries: ['a', '', null, 'b', 3] });
  assert.deepEqual(plan.entries, ['a', 'b']);

  // steps 优先于 entries
  const both = buildPlan({ entries: ['x'], steps: [{ entry: 'y' }] });
  assert.deepEqual(both.entries, ['y']);
});

test('buildPlan: 空计划', () => {
  assert.deepEqual(buildPlan({}), { entries: [], stepTimeouts: {} });
  assert.deepEqual(buildPlan({ steps: [{ entry: 'a', enabled: false }] }).entries, []);
});

// ------------------------------------------------------------ 执行

test('start: 按顺序执行、记录运行、结束回到 idle', async () => {
  const { runner, env } = makeRunner();

  const result = await runner.start({
    entries: ['联盟日常', '启动游戏'],
    instance: 0,
    retry: 1,
    preset: 'daily',
    presetName: '每日必做',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(env.runs[0].entries, ['联盟日常', '启动游戏'], '顺序必须与给定一致');
  assert.equal(env.runs[0].opts.retry, 1);
  assert.equal(events.ext.phase, 'idle');
  assert.equal(events.state.running, false);
  assert.equal(events.state.finishedAt > 0, true, '应当留下结束时间');

  const runs = events.getRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].presetId, 'daily');
  assert.equal(runs[0].presetName, '每日必做');
  assert.equal(runs[0].status, 'ok');
  assert.deepEqual(
    runs[0].results.map((r) => r.entry),
    ['联盟日常', '启动游戏'],
  );
});

test('start: 空计划直接抛错且不产生运行记录', async () => {
  const { runner, env } = makeRunner();
  await assert.rejects(() => runner.start({ steps: [{ entry: 'a', enabled: false }] }), /没有要执行的任务/);
  assert.equal(env.runs.length, 0);
  assert.equal(events.getRuns().length, 0);
});

test('start: 单步超时透传到 runTasks', async () => {
  const { runner, env } = makeRunner();
  await runner.start({
    steps: [{ entry: 'a', timeoutMs: 5000 }, { entry: 'b' }],
  });
  assert.deepEqual(env.runs[0].opts.stepTimeouts, { a: 5000 });
});

test('start: 运行时参数覆盖只影响本次执行，不写回配置', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { runner, env } = makeRunner();
  const before = config.runtime.taskTimeoutMs;

  await runner.start({ entries: ['a'], runtime: { taskTimeoutMs: 1234, logLevel: 'debug' } });
  assert.equal(env.runs[0].runtime.taskTimeoutMs, 1234, '本次执行应当用覆盖值');
  assert.equal(env.runs[0].runtime.logLevel, 'debug');
  assert.equal(config.runtime.taskTimeoutMs, before, '原配置不应被改动');
});

test('start: 无法识别的运行时参数被忽略（不炸）', async () => {
  const { runner, env } = makeRunner();
  await runner.start({ entries: ['a'], runtime: { 乱写的: 1, taskTimeoutMs: 'x' } });
  assert.equal(env.runs[0].runtime.taskTimeoutMs, DEFAULT_CONFIG.runtime.taskTimeoutMs);
});

test('start: 运行中再启动会被串行队列挡住（不会并发抢设备）', async () => {
  let release = null;
  let concurrent = 0;
  let maxConcurrent = 0;
  const { runner } = makeRunner({
    runTasks: async (tasker, controller, entries) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => {
        release = r;
      });
      concurrent--;
      return { ok: true, results: [] };
    },
  });

  const p1 = runner.start({ entries: ['a'] });
  // 等第一次真正进入 runTasks
  for (let i = 0; i < 100 && !release; i++) await sleep(5);
  assert.ok(release, '第一次应当已进入执行');

  const p2 = runner.start({ entries: ['b'] });
  await sleep(30);
  assert.equal(maxConcurrent, 1, '同一时刻只能有一个任务在用控制器');

  release();
  await p1;
  // 第一轮结束后第二次才会开始
  for (let i = 0; i < 100 && !events.getRuns().some((r) => r.status !== 'running' && r.entries[0] === 'b'); i++) {
    await sleep(5);
  }
  release?.();
  await p2.catch(() => {});
  assert.equal(maxConcurrent, 1);
});

test('start: 执行抛错时状态收敛为 failed 并向上抛', async () => {
  const { runner } = makeRunner({
    runTasks: async () => {
      throw new Error('设备掉线');
    },
  });
  await assert.rejects(() => runner.start({ entries: ['a'] }), /设备掉线/);
  assert.equal(events.ext.phase, 'idle');
  const runs = events.getRuns();
  assert.equal(runs[0].status, 'failed');
  assert.match(runs[0].error, /设备掉线/);
});

test('start: 任务失败（ok=false）时状态是 failed', async () => {
  const { runner } = makeRunner({
    runTasks: async () => ({ ok: false, results: [{ entry: 'a', ok: false }] }),
  });
  const r = await runner.start({ entries: ['a'] });
  assert.equal(r.ok, false);
  assert.equal(events.getRuns()[0].status, 'failed');
});

// ------------------------------------------------------------ 控制器复用

test('控制器复用：实时画面先连，随后执行不再新建控制器', async () => {
  const { runner, env } = makeRunner();

  await runner.startLive();
  assert.equal(env.controller, 1);
  assert.equal(runner.hasLiveController(), true);

  await runner.start({ entries: ['a'] });
  assert.equal(env.controller, 1, '执行时应当复用常驻控制器');

  await runner.shot();
  assert.equal(env.controller, 1, '截图也应当复用');
  assert.equal(env.shots, 1);
});

test('控制器复用：不打开实时画面时执行时才建控制器', async () => {
  const { runner, env } = makeRunner();
  assert.equal(env.controller, 0);
  await runner.start({ entries: ['a'] });
  assert.equal(env.controller, 1);
});

test('资源缓存：连续执行只加载一次；invalidateResource 后重新加载', async () => {
  const { runner, env } = makeRunner();
  await runner.start({ entries: ['a'] });
  await runner.start({ entries: ['b'] });
  assert.equal(env.resource, 1, '资源应当被缓存');

  runner.invalidateResource();
  await runner.start({ entries: ['c'] });
  assert.equal(env.resource, 2, '失效后应当重新加载');
});

// ------------------------------------------------------------ 单节点与手动操作

test('runNode: 校验节点存在，并把单次超时传下去', async () => {
  const { runner, env } = makeRunner();
  const r = await runner.runNode('联盟日常', { timeoutMs: 1234 });
  assert.equal(r.ok, true);
  assert.deepEqual(env.nodeRuns[0], { index: 0, node: '联盟日常', timeoutMs: 1234 });

  await assert.rejects(() => runner.runNode('不存在的节点'), /资源里没有节点/);
  await assert.rejects(() => runner.runNode(''), /缺少节点名/);
});

test('runNode: 未给超时时用配置里的 taskTimeoutMs', async () => {
  const { runner, env } = makeRunner();
  await runner.runNode('联盟日常');
  assert.equal(env.nodeRuns[0].timeoutMs, DEFAULT_CONFIG.runtime.taskTimeoutMs);
});

test('手动点击/滑动：正常路径与坐标取整', async () => {
  const { runner, env } = makeRunner();
  await runner.tap(12.6, 34.2);
  await runner.swipe([1, 2], [3, 4], 500);
  assert.deepEqual(env.taps, [[13, 34]]);
  assert.deepEqual(env.swipes, [[[1, 2], [3, 4], 500]]);
});

test('手动点击/滑动：任务运行期间被拒绝', async () => {
  let release = null;
  const { runner, env } = makeRunner({
    runTasks: async () => {
      await new Promise((r) => {
        release = r;
      });
      return { ok: true, results: [] };
    },
  });

  const p = runner.start({ entries: ['a'] });
  for (let i = 0; i < 100 && !release; i++) await sleep(5);

  await assert.rejects(() => runner.tap(1, 1), /任务运行期间不能手动操作/);
  await assert.rejects(() => runner.swipe([1, 1], [2, 2]), /任务运行期间不能手动操作/);
  assert.deepEqual(env.taps, [], '被拒绝时不应真的点下去');

  release();
  await p;
});

test('startLive: 任务运行期间被拒绝', async () => {
  let release = null;
  const { runner } = makeRunner({
    runTasks: async () => {
      await new Promise((r) => {
        release = r;
      });
      return { ok: true, results: [] };
    },
  });
  const p = runner.start({ entries: ['a'] });
  for (let i = 0; i < 100 && !release; i++) await sleep(5);

  await assert.rejects(() => runner.startLive(), /任务运行期间不能打开实时画面/);
  release();
  await p;
});

test('stopLive: 断开后不再复用控制器', async () => {
  const { runner, env } = makeRunner();
  await runner.startLive();
  await runner.stopLive();
  assert.equal(runner.hasLiveController(), false);
  await runner.shot();
  assert.equal(env.controller, 2, '断开后应当重新建立控制器');
});

// ------------------------------------------------------------ 状态与守护

test('isBusy / getPhase: 空闲与运行中的形态', async () => {
  const { runner } = makeRunner();
  assert.equal(runner.isBusy(), false);
  assert.equal(runner.getPhase(), 'idle');

  let release = null;
  const r2 = makeRunner({
    runTasks: async () => {
      await new Promise((r) => {
        release = r;
      });
      return { ok: true, results: [] };
    },
  });
  const p = r2.runner.start({ entries: ['a'] });
  for (let i = 0; i < 100 && !release; i++) await sleep(5);
  assert.equal(r2.runner.isBusy(), true);
  assert.equal(r2.runner.getPhase(), 'running');
  release();
  await p;
  assert.equal(r2.runner.isBusy(), false);
});

test('stop: 有任务时中断 tasker，无任务时返回 false', async () => {
  let stopped = 0;
  let release = null;
  const { runner } = makeRunner({
    // 这个假执行一直挂着，直到 post_stop 被调用才结束 —— 正是真实场景
    runTasks: async (tasker) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { ok: true, results: [] };
    },
    taskerFactory: () => ({
      post_task: () => {},
      post_stop: () => ({
        wait: async () => {
          stopped++;
          release?.();
        },
      }),
    }),
  });

  assert.equal(await runner.stop(), false, '空闲时没有可停止的任务');

  const p = runner.start({ entries: ['a'] });
  for (let i = 0; i < 200 && !release; i++) await sleep(5);
  assert.ok(release, '前提：执行已经进入 runTasks');

  assert.equal(await runner.stop(), true, '运行中应当能停止');
  await p;
  assert.equal(stopped, 1);
});

test('installCleanup: 注册并可在收尾时安全执行', async () => {
  const { runner } = makeRunner();
  const unregister = runner.installCleanup();
  assert.equal(typeof unregister, 'function');
  unregister();
});

test('getResourceInfo: 未加载时为 null，加载后给出节点', async () => {
  const { runner } = makeRunner();
  assert.equal(runner.getResourceInfo(), null);
  await runner.start({ entries: ['a'] });
  assert.deepEqual(runner.getResourceInfo().nodes, ['启动游戏', '联盟日常', '回到主界面']);
});

test('缺少必需工厂时给出明确错误', async () => {
  // createWebRunner 返回的就是 runner 本身（不是 { runner }）
  const runner = createWebRunner({
    config: structuredClone(DEFAULT_CONFIG),
    logger: silent,
    // 只给 tasker 与 runTasks，缺 instanceFactory / controllerFactory / resourceFactory
    taskerFactory: () => ({ post_task: () => {} }),
    runTasks: async () => ({ ok: true, results: [] }),
  });
  await assert.rejects(() => runner.start({ entries: ['a'] }), /instanceFactory/);
});

test('createWebRunner: 既没有 config 也没有 getConfig 时立刻报错', () => {
  assert.throws(
    () => createWebRunner({ logger: silent }),
    /需要 config 或 getConfig/,
    '配置缺失应当给出可读的报错，而不是抛 undefined 的方法调用',
  );
});
