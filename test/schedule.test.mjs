import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseCron,
  matchesCron,
  nextRunAt,
  describeNextRun,
  createScheduler,
  CRON_EXAMPLES,
} from '../src/schedule.mjs';
import { PATHS } from '../src/config.mjs';

// ------------------------------------------------------------ 解析

test('parseCron: 接受 5 段表达式并给出取值集合', () => {
  const p = parseCron('30 7 * * 1-5');
  assert.equal(p.ok, true);
  assert.ok(p.sets[0].has(30));
  assert.equal(p.sets[0].size, 1, '分钟只有 30');
  assert.deepEqual([...p.sets[1]], [7], '小时只有 7');
  assert.equal(p.sets[2].size, 31, '日为 *');
  assert.equal(p.sets[3].size, 12, '月为 *');
  assert.deepEqual([...p.sets[4]].sort((a, b) => a - b), [1, 2, 3, 4, 5], '周一至周五');
});

test('parseCron: 支持 */s、a-b/s、逗号列表与单值', () => {
  assert.deepEqual([...parseCron('*/15 * * * *').sets[0]].sort((a, b) => a - b), [0, 15, 30, 45]);

  const ranged = parseCron('0 0-12/6 * * *');
  assert.deepEqual([...ranged.sets[1]].sort((a, b) => a - b), [0, 6, 12], '0-12 步长 6');

  const list = parseCron('0 12,20 * * *');
  assert.deepEqual([...list.sets[1]].sort((a, b) => a - b), [12, 20]);

  const stepped = parseCron('5/10 * * * *');
  assert.deepEqual([...stepped.sets[0]].sort((a, b) => a - b), [5, 15, 25, 35, 45, 55]);
});

test('parseCron: 星期 7 归一到 0（周日）', () => {
  const a = parseCron('0 8 * * 0');
  const b = parseCron('0 8 * * 7');
  assert.deepEqual([...a.sets[4]], [0]);
  assert.deepEqual([...b.sets[4]], [0], '7 应当等价于 0');
});

test('parseCron: 各类非法输入给出可读错误', () => {
  const cases = [
    ['', '空'],
    ['   ', '空'],
    ['* * * *', '5 段'],
    ['* * * * * *', '5 段'],
    ['60 * * * *', '分钟超出范围'],
    ['* 24 * * *', '小时超出范围'],
    ['* * 0 * *', '日超出范围'],
    ['* * 32 * *', '日超出范围'],
    ['* * * 13 *', '月超出范围'],
    ['* * * * 8', '星期超出范围'],
    ['*/0 * * * *', '步长'],
    ['a * * * *', '无法解析'],
    ['5-1 * * * *', '超出范围'],
    ['1,,2 * * * *', '空项'],
    [null, '字符串'],
    [123, '字符串'],
  ];
  for (const [expr, needle] of cases) {
    const r = parseCron(expr);
    assert.equal(r.ok, false, `${JSON.stringify(expr)} 应当解析失败`);
    assert.ok(
      r.error.includes(needle),
      `${JSON.stringify(expr)} 的错误应包含「${needle}」，实际：${r.error}`,
    );
  }
});

test('CRON_EXAMPLES: 每条示例都能解析', () => {
  for (const e of CRON_EXAMPLES) {
    assert.equal(parseCron(e.expr).ok, true, `${e.expr}（${e.text}）应当可解析`);
  }
});

// ------------------------------------------------------------ 匹配

test('matchesCron: 分钟粒度匹配', () => {
  const c = parseCron('30 7 * * *');
  assert.equal(matchesCron(c, new Date(2026, 8, 22, 7, 30, 59)), true, '同分钟不同秒也算命中');
  assert.equal(matchesCron(c, new Date(2026, 8, 22, 7, 31)), false);
  assert.equal(matchesCron(c, new Date(2026, 8, 22, 8, 30)), false);
});

test('matchesCron: 只限定「日」时忽略星期', () => {
  const c = parseCron('0 0 15 * *');
  assert.equal(matchesCron(c, new Date(2026, 8, 15, 0, 0)), true);
  assert.equal(matchesCron(c, new Date(2026, 8, 16, 0, 0)), false);
});

test('matchesCron: 日与星期同时限定时是「或」关系（cron 惯例）', () => {
  const c = parseCron('0 0 1 * 1');
  // 2026-09-01 是周二：不是周一，但日子是 1 号 → 命中
  assert.equal(matchesCron(c, new Date(2026, 8, 1, 0, 0)), true, '1 号命中');
  // 2026-09-07 是周一：不是 1 号，但星期命中
  assert.equal(matchesCron(c, new Date(2026, 8, 7, 0, 0)), true, '周一命中');
  // 2026-09-08 周二且非 1 号 → 不命中
  assert.equal(matchesCron(c, new Date(2026, 8, 8, 0, 0)), false);
});

test('matchesCron: 工作日表达式命中周一、不命中周六', () => {
  const c = parseCron('0 8 * * 1-5');
  assert.equal(matchesCron(c, new Date(2026, 8, 21, 8, 0)), true, '2026-09-21 是周一');
  assert.equal(matchesCron(c, new Date(2026, 8, 26, 8, 0)), false, '2026-09-26 是周六');
});

// ------------------------------------------------------------ 下次触发

test('nextRunAt: 严格晚于给定时刻', () => {
  const from = new Date(2026, 8, 22, 7, 30, 0);
  const next = nextRunAt('30 7 * * *', from);
  assert.equal(next.getDate(), 23, '当天 07:30 已过，应当推到次日');
  assert.equal(next.getHours(), 7);
  assert.equal(next.getMinutes(), 30);
});

test('nextRunAt: 同一天内推进到下一个整点', () => {
  const next = nextRunAt('0 */6 * * *', new Date(2026, 8, 22, 7, 5));
  assert.equal(next.getHours(), 12);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 22);
});

test('nextRunAt: 跨月与跨年', () => {
  const monthEnd = nextRunAt('0 0 1 * *', new Date(2026, 8, 30, 12, 0));
  assert.equal(monthEnd.getMonth(), 9, '应当推到 10 月 1 日');
  assert.equal(monthEnd.getDate(), 1);

  const yearEnd = nextRunAt('0 0 1 1 *', new Date(2026, 8, 22, 0, 0));
  assert.equal(yearEnd.getFullYear(), 2027);
  assert.equal(yearEnd.getMonth(), 0);
  assert.equal(yearEnd.getDate(), 1);
});

test('nextRunAt: 非法表达式返回 null', () => {
  assert.equal(nextRunAt('nope', new Date()), null);
  assert.equal(nextRunAt('', new Date()), null);
});

test('describeNextRun: 输出可读时间且与 nextRunAt 一致', () => {
  const from = new Date(2026, 8, 22, 7, 31);
  const text = describeNextRun('30 7 * * *', from);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(text, /07:30$/);
});

// ------------------------------------------------------------ 调度器

/** 固定时刻的假时钟。 */
function fixedClock(date) {
  return () => new Date(date.getTime());
}

test('createScheduler: 到点触发 onFire，且同一分钟不重复触发', async () => {
  const fired = [];
  const s = createScheduler({
    getPresets: () => [
      { id: 'daily', name: '每日', schedule: { enabled: true, cron: '30 7 * * *' } },
    ],
    onFire: async (p, info) => fired.push({ id: p.id, info }),
    now: fixedClock(new Date(2026, 8, 22, 7, 30, 10)),
  });

  const r1 = await s.tick();
  assert.equal(r1.fired, 1);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].info.trigger, 'schedule');

  const r2 = await s.tick();
  assert.equal(r2.fired, 0, '同一分钟不应再次触发');
  assert.equal(fired.length, 1);
});

test('createScheduler: 上一次还在跑时，同分钟再次 tick 也必须跳过（回归）', async () => {
  // 真实场景：任务集跑得比 30s 的检查间隔还久。第一次 tick 触发的 onFire 还没返回，
  // 第二次 tick 就来了。此时既不能重复触发（早先的 bug 会让上一次运行被记成
  // stopped 然后重新起一轮），也不能因为 tick 被占用而漏记。
  const fired = [];
  let release = null;
  const s = createScheduler({
    getPresets: () => [{ id: 'a', name: 'A', schedule: { enabled: true, cron: '0 8 * * *' } }],
    onFire: async (p) => {
      fired.push(p.id);
      await new Promise((r) => {
        release = r;
      });
    },
    now: fixedClock(new Date(2026, 8, 22, 8, 0, 5)),
  });

  const first = s.tick();
  // 等 onFire 真的被调用
  for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(fired.length, 1, '前提：第一次已经触发');

  // 第一次还没结束，第二次 tick 来敲门 —— 必须被 busy 挡住
  const second = await s.tick();
  assert.equal(second.busy, true);
  assert.equal(second.fired, 0);
  assert.equal(fired.length, 1, '绝不能重复触发');

  release();
  await first;
  assert.equal(fired.length, 1);

  // 同分钟再 tick 仍然不触发
  const third = await s.tick();
  assert.equal(third.fired, 0);
  assert.equal(fired.length, 1);
  assert.equal(s.getHistory().filter((h) => h.result === 'fired').length, 1, '历史里只应有一条 fired');
});

test('createScheduler: 每次触发在历史里只记一条（回归）', async () => {
  // 早先 appendHistory 与调用方都 unshift，界面上每次触发显示两条，
  // 看起来像「触发了两次」，排查时会严重误导。
  const s = createScheduler({
    getPresets: () => [{ id: 'a', name: 'A', schedule: { enabled: true, cron: '0 8 * * *' } }],
    onFire: async () => {},
    now: fixedClock(new Date(2026, 8, 22, 8, 0, 30)),
  });
  await s.tick();
  const history = s.getHistory();
  assert.equal(history.filter((h) => h.result === 'fired').length, 1, JSON.stringify(history));
});

test('createScheduler: 忙碌跳过时历史也只记一条', async () => {
  const s = createScheduler({
    getPresets: () => [{ id: 'a', name: 'A', schedule: { enabled: true, cron: '0 8 * * *' } }],
    onFire: async () => {},
    canRun: () => false,
    now: fixedClock(new Date(2026, 8, 22, 8, 0, 30)),
  });
  await s.tick();
  const history = s.getHistory();
  assert.equal(history.filter((h) => h.result === 'skipped').length, 1, JSON.stringify(history));
});

test('createScheduler: 未到点不触发', async () => {
  let count = 0;
  const s = createScheduler({
    getPresets: () => [{ id: 'a', name: 'A', schedule: { enabled: true, cron: '0 8 * * *' } }],
    onFire: async () => {
      count++;
    },
    now: fixedClock(new Date(2026, 8, 22, 7, 59)),
  });
  await s.tick();
  assert.equal(count, 0);
});

test('createScheduler: 关闭的或 cron 为空的 preset 被忽略', async () => {
  let count = 0;
  const s = createScheduler({
    getPresets: () => [
      { id: 'a', name: 'A', schedule: { enabled: false, cron: '0 8 * * *' } },
      { id: 'b', name: 'B', schedule: { enabled: true, cron: '' } },
      { id: 'c', name: 'C' },
    ],
    onFire: async () => {
      count++;
    },
    now: fixedClock(new Date(2026, 8, 22, 8, 0)),
  });
  const r = await s.tick();
  assert.equal(count, 0);
  assert.equal(r.checked, 0);
});

test('createScheduler: 忙碌时跳过本次并记账（不排队堆积）', async () => {
  const events = [];
  let count = 0;
  const s = createScheduler({
    getPresets: () => [{ id: 'a', name: 'A', schedule: { enabled: true, cron: '0 8 * * *' } }],
    onFire: async () => {
      count++;
    },
    canRun: () => false,
    onEvent: (msg, level) => events.push({ msg, level }),
    now: fixedClock(new Date(2026, 8, 22, 8, 0, 5)),
  });

  const r = await s.tick();
  assert.equal(r.skipped, 1);
  assert.equal(count, 0, '忙碌时不应真的执行');
  assert.ok(events.some((e) => e.msg.includes('跳过')), '应当有跳过日志');

  // 同一分钟不重复记账
  const r2 = await s.tick();
  assert.equal(r2.skipped, 0);
});

test('createScheduler: onFire 抛错不打断其它任务', async () => {
  const fired = [];
  const s = createScheduler({
    getPresets: () => [
      { id: 'bad', name: '坏', schedule: { enabled: true, cron: '0 8 * * *' } },
      { id: 'good', name: '好', schedule: { enabled: true, cron: '0 8 * * *' } },
    ],
    onFire: async (p) => {
      if (p.id === 'bad') throw new Error('模拟失败');
      fired.push(p.id);
    },
    now: fixedClock(new Date(2026, 8, 22, 8, 0)),
  });
  await s.tick();
  assert.deepEqual(fired, ['good'], '坏任务抛错后，好任务仍应执行');
});

test('createScheduler: jobs() 给出下次触发时间与非法 cron 提示', () => {
  const s = createScheduler({
    getPresets: () => [
      { id: 'a', name: 'A', schedule: { enabled: true, cron: '0 8 * * *' } },
      { id: 'b', name: 'B', schedule: { enabled: true, cron: '坏表达式' } },
    ],
    onFire: async () => {},
    now: fixedClock(new Date(2026, 8, 22, 7, 0)),
  });
  const jobs = s.jobs();
  assert.equal(jobs.length, 2);

  const a = jobs.find((j) => j.presetId === 'a');
  assert.equal(a.ok, true);
  assert.match(a.nextText, /2026-09-22 08:00$/);

  const b = jobs.find((j) => j.presetId === 'b');
  assert.equal(b.ok, false);
  assert.ok(b.error, '非法 cron 应当带出错误原因');
  assert.equal(b.next, null);
});

test('createScheduler: start/stop 幂等', () => {
  const s = createScheduler({
    getPresets: () => [],
    onFire: async () => {},
  });
  s.start(100000);
  s.start(100000); // 第二次不应叠加定时器
  s.stop();
  s.stop(); // 重复 stop 也不应抛错
  assert.equal(s.isRunning(), false);
});

test('createScheduler: 触发历史落盘到 debug/schedule.jsonl', async () => {
  const backup = fs.existsSync(PATHS.scheduleLog)
    ? fs.readFileSync(PATHS.scheduleLog)
    : null;
  fs.rmSync(PATHS.scheduleLog, { force: true });
  try {
    const s = createScheduler({
      getPresets: () => [{ id: 'a', name: 'A', schedule: { enabled: true, cron: '0 8 * * *' } }],
      onFire: async () => {},
      now: fixedClock(new Date(2026, 8, 22, 8, 0)),
    });
    await s.tick();
    assert.ok(fs.existsSync(PATHS.scheduleLog), '应当生成调度日志');
    const lines = fs
      .readFileSync(PATHS.scheduleLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].result, 'fired');
    assert.equal(lines[0].presetId, 'a');
    assert.ok(path.basename(PATHS.scheduleLog) === 'schedule.jsonl');
  } finally {
    fs.rmSync(PATHS.scheduleLog, { force: true });
    fs.rmSync(`${PATHS.scheduleLog}.1`, { force: true });
    if (backup) fs.writeFileSync(PATHS.scheduleLog, backup);
  }
});
