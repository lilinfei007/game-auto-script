import test from 'node:test';
import assert from 'node:assert/strict';

import { runTasks } from '../src/runner.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import * as events from '../src/events.mjs';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** 最小的假 tasker：只要 post_task 返回一个能成功的 job。 */
function fakeTasker() {
  return {
    add_sink() {},
    add_context_sink() {},
    post_task: () => ({ wait: () => ({ succeeded: Promise.resolve(true) }) }),
    post_stop: () => ({ wait: () => {} }),
    node_detail: () => null,
  };
}

test('runTasks: 调用方已经建好运行记录时，不得把它顶掉（回归）', async () => {
  // 背景：执行层（runner-web）会带 preset / trigger 调 events.startRun()；
  // 早先 runTasks 里无条件 events.beginRun()，会把那条记录记成 stopped 再另起一条
  // 没有 trigger/preset 的（trigger 落回 'manual'）。现象是「一次定时执行变成两条
  // 记录、第一条是 stopped」，看起来像重复触发。
  events.resetForTest();

  const owned = events.startRun(['回到主界面'], {
    preset: 'daily',
    presetName: '每日必做',
    trigger: 'schedule',
    instance: 0,
  });
  assert.equal(owned.trigger, 'schedule');

  try {
    const r = await runTasks(
      fakeTasker(),
      { post_screencap: () => ({}) },
      ['回到主界面'],
      DEFAULT_CONFIG,
      silent,
      {},
      {},
    );
    assert.equal(r.ok, true);

    const runs = events.getRuns();
    assert.equal(runs.length, 1, `只应有一条运行记录，实际 ${runs.length} 条：${JSON.stringify(runs.map((x) => x.trigger))}`);
    assert.equal(runs[0].id, owned.id, '应当沿用调用方创建的那条');
    assert.equal(runs[0].trigger, 'schedule', 'trigger 必须保持调度来源');
    assert.equal(runs[0].presetId, 'daily');
    assert.equal(runs[0].status, 'ok');
    assert.deepEqual(runs[0].results.map((x) => x.entry), ['回到主界面']);
  } finally {
    events.resetForTest();
  }
});

test('runTasks: 没有活跃运行时自己兜底建一条记录（CLI 直接调用的路径）', async () => {
  events.resetForTest();
  try {
    const r = await runTasks(
      fakeTasker(),
      { post_screencap: () => ({}) },
      ['a', 'b'],
      DEFAULT_CONFIG,
      silent,
      {},
      {},
    );
    assert.equal(r.ok, true);
    const runs = events.getRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, 'manual', '无调用方时应落到默认的 manual');
    assert.deepEqual(runs[0].entries, ['a', 'b']);
    assert.equal(runs[0].status, 'ok');
  } finally {
    events.resetForTest();
  }
});

test('runTasks: 单步超时优先于 runtime.taskTimeoutMs', async () => {
  events.resetForTest();
  // 用一个永不结束的 job，让超时分支真的走到
  const tasker = {
    add_sink() {},
    add_context_sink() {},
    post_task: () => ({ wait: () => ({ succeeded: new Promise(() => {}) }) }),
    post_stop: () => ({ wait: () => {} }),
    node_detail: () => null,
  };
  const config = { ...DEFAULT_CONFIG, runtime: { ...DEFAULT_CONFIG.runtime, taskTimeoutMs: 600000 } };

  try {
    const started = Date.now();
    const r = await runTasks(tasker, { post_screencap: () => ({}) }, ['慢任务'], config, silent, {}, {
      stepTimeouts: { 慢任务: 150 },
    });
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false, '应当在单步超时后判失败');
    assert.match(r.results[0].reason, /超时/, r.results[0].reason);
    assert.match(r.results[0].reason, /0s|1s/, `原因里应写 150ms 舍入后的秒数：${r.results[0].reason}`);
    assert.ok(elapsed < 5000, `应当在单步超时附近结束，实际 ${elapsed}ms（说明用的是 600s 的全局超时）`);
  } finally {
    events.resetForTest();
  }
});
