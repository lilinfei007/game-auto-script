import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  TASKS_VERSION,
  PRESET_ID_RE,
  defaultTaskConfig,
  validateTaskConfig,
  normalizeTaskConfig,
  resolvePresetSteps,
  reorderSteps,
  toggleStep,
  upsertPreset,
  removePreset,
  uniquePresetId,
  blankPreset,
  reconcilePreset,
  hasScheduledPresets,
  getPreset,
  readTaskConfig,
  writeTaskConfig,
} from '../src/task-config.mjs';
import { PATHS } from '../src/config.mjs';
import { discoverModules } from '../src/resource.mjs';

const nodes = ['启动游戏', '联盟日常', '回到主界面'];

/** 一份合法任务集：两个 preset、含开关与定时。 */
function goodConfig() {
  return {
    version: TASKS_VERSION,
    defaults: { instance: 0, retry: 0, taskTimeoutMs: 600000 },
    presets: [
      {
        id: 'daily',
        name: '每日必做',
        enabled: true,
        instance: 0,
        retry: 1,
        runtime: { saveFailureShot: true },
        steps: [
          { entry: '联盟日常', enabled: true, label: '联盟互助+宝箱', timeoutMs: 300000 },
          { entry: '启动游戏', enabled: false },
        ],
        schedule: { enabled: true, cron: '0 8 * * *', timezone: 'local' },
      },
      {
        id: 'quick',
        name: '快速',
        steps: [{ entry: '启动游戏' }],
        schedule: { enabled: false, cron: '' },
      },
    ],
  };
}

// ------------------------------------------------------------ 校验

test('validateTaskConfig: 合法任务集无错误无警告', () => {
  const { errors, warnings } = validateTaskConfig(goodConfig(), { knownNodes: nodes });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('validateTaskConfig: 顶层与 presets 的形态错误', () => {
  for (const [input, needle] of [
    [null, '顶层'],
    [[], '顶层'],
    ['x', '顶层'],
    [{ version: 1, presets: {} }, 'presets'],
    [{ version: 2, presets: [] }, 'version'],
  ]) {
    const { errors } = validateTaskConfig(input);
    assert.ok(
      errors.some((e) => e.includes(needle)),
      `${JSON.stringify(input)} 应报出含「${needle}」的错误，实际 ${JSON.stringify(errors)}`,
    );
  }
});

test('validateTaskConfig: preset 各字段的非法值都能指出', () => {
  const cases = [
    ['id 非法', (c) => (c.presets[0].id = 'Daily')],
    ['id 非法', (c) => (c.presets[0].id = '')],
    ['id 非法', (c) => (c.presets[0].id = 'a'.repeat(40))],
    ['id 重复', (c) => (c.presets[1].id = 'daily')],
    ['name', (c) => (c.presets[0].name = '  ')],
    ['enabled', (c) => (c.presets[0].enabled = 'yes')],
    ['instance', (c) => (c.presets[0].instance = -1)],
    ['retry', (c) => (c.presets[0].retry = 9)],
    ['runtime 必须是对象', (c) => (c.presets[0].runtime = [])],
    ['steps 必须是数组', (c) => (c.presets[0].steps = {})],
    ['entry 非法', (c) => (c.presets[0].steps[0].entry = '')],
    ['entry 非法', (c) => (c.presets[0].steps[0].entry = 'a/b')],
    ['enabled 必须是布尔', (c) => (c.presets[0].steps[0].enabled = 1)],
    ['timeoutMs', (c) => (c.presets[0].steps[0].timeoutMs = 0)],
    ['label', (c) => (c.presets[0].steps[0].label = 'x'.repeat(65))],
    ['schedule 必须是对象', (c) => (c.presets[0].schedule = [])],
    ['cron 无法解析', (c) => (c.presets[0].schedule.cron = '99 99 * * *')],
    ['cron 必须是字符串', (c) => (c.presets[0].schedule.cron = 5)],
    ['cron 在 enabled 为 true 时必填', (c) => delete c.presets[0].schedule.cron],
    ['defaults.instance', (c) => (c.defaults.instance = -1)],
    ['defaults.taskTimeoutMs', (c) => (c.defaults.taskTimeoutMs = -5)],
  ];
  for (const [needle, mutate] of cases) {
    const c = goodConfig();
    mutate(c);
    const { errors } = validateTaskConfig(c);
    assert.ok(
      errors.some((e) => e.includes(needle)),
      `期望报出含「${needle}」的错误，实际 ${JSON.stringify(errors)}`,
    );
  }
});

test('validateTaskConfig: entry 解析不了的报错（给了 knownNodes 时）', () => {
  const c = goodConfig();
  c.presets[0].steps[0].entry = '不存在的模块';
  const { errors } = validateTaskConfig(c, { knownNodes: nodes });
  assert.ok(errors.some((e) => e.includes('无法解析')), JSON.stringify(errors));

  // 不传 knownNodes 时不该报「无法解析」（纯结构校验）
  const soft = validateTaskConfig(c);
  assert.ok(!soft.errors.some((e) => e.includes('无法解析')));
});

test('validateTaskConfig: 未知 runtime 键与重复 entry 只给 warning', () => {
  const c = goodConfig();
  c.presets[0].runtime = { saveFailureShot: true, 乱写的: 1 };
  c.presets[0].steps.push({ entry: '联盟日常' });
  const { errors, warnings } = validateTaskConfig(c);
  assert.deepEqual(errors, [], '这些不应是错误');
  assert.ok(warnings.some((w) => w.includes('乱写的')));
  assert.ok(warnings.some((w) => w.includes('重复出现')));
});

test('validateTaskConfig: timezone 非 local 只提示', () => {
  const c = goodConfig();
  c.presets[0].schedule.timezone = 'UTC';
  const { errors, warnings } = validateTaskConfig(c);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('timezone')));
});

test('validateTaskConfig: 关闭状态下的空 cron 是合法默认值', () => {
  // 回归：界面新建的任务集默认就是 { enabled:false, cron:'' }，
  // 早先把空 cron 当成解析失败，导致「新建后一保存就报错」。
  const c = {
    version: TASKS_VERSION,
    defaults: { instance: 0, retry: 0, taskTimeoutMs: 600000 },
    presets: [{ id: 'a', name: 'A', steps: [], schedule: { enabled: false, cron: '' } }],
  };
  const { errors } = validateTaskConfig(c);
  assert.deepEqual(errors, []);

  // 开启但 cron 为空 → 必须报错
  c.presets[0].schedule.enabled = true;
  assert.ok(validateTaskConfig(c).errors.some((e) => e.includes('必填')));

  // 关闭但 cron 写错了 → 仍要报错（否则用户保存后一直不知道写错）
  c.presets[0].schedule.enabled = false;
  c.presets[0].schedule.cron = '99 99 * * *';
  assert.ok(validateTaskConfig(c).errors.some((e) => e.includes('无法解析')));
});

// ------------------------------------------------------------ 规范化

test('normalizeTaskConfig: 补齐缺省字段且不改动输入', () => {
  const input = { presets: [{ id: 'a', steps: [{ entry: '启动游戏' }] }] };
  const frozen = JSON.parse(JSON.stringify(input));
  const out = normalizeTaskConfig(input);

  assert.equal(out.version, TASKS_VERSION);
  assert.equal(out.defaults.taskTimeoutMs, 600000);
  assert.equal(out.presets[0].name, 'a', 'name 缺省时用 id');
  assert.equal(out.presets[0].enabled, true);
  assert.equal(out.presets[0].steps[0].enabled, true, 'step.enabled 缺省视为开启');
  assert.equal(out.presets[0].schedule.enabled, false);
  assert.equal(out.presets[0].schedule.timezone, 'local');
  assert.deepEqual(input, frozen, '不应修改输入对象');
});

test('defaultTaskConfig: 每次都是独立副本', () => {
  const a = defaultTaskConfig();
  a.presets.push({ id: 'x' });
  assert.equal(defaultTaskConfig().presets.length, 0, '不应被上一次修改污染');
});

test('PRESET_ID_RE: 允许与拒绝的形态', () => {
  for (const ok of ['daily', 'a', 'a1', 'daily-2', 'a_b', '0x']) {
    assert.equal(PRESET_ID_RE.test(ok), true, `${ok} 应当合法`);
  }
  for (const bad of ['A', '_a', '-a', 'a b', 'a.b', '中文', '']) {
    assert.equal(PRESET_ID_RE.test(bad), false, `${bad} 应当非法`);
  }
});

// ------------------------------------------------------------ 步骤解析与变更

test('resolvePresetSteps: 过滤关闭的步骤、保留顺序、解析文件名到节点名', () => {
  const modules = discoverModules();
  assert.ok(modules.length > 0, '前提：pipeline 目录里有模块');
  const allNodes = modules.filter((m) => m.ok).map((m) => m.entry);

  const preset = {
    id: 'p',
    steps: [
      { entry: modules[1].base, enabled: true, timeoutMs: 1000 }, // 用文件名
      { entry: modules[0].entry, enabled: false }, // 关闭
      { entry: modules[0].entry, enabled: true }, // 开启
    ],
  };
  const { entries, timeouts } = resolvePresetSteps(preset, allNodes);
  assert.deepEqual(entries, [modules[1].entry, modules[0].entry], '顺序应保持，关闭的被跳过');
  assert.deepEqual(timeouts, { [modules[1].entry]: 1000 });
});

test('reorderSteps: 按给定顺序重排', () => {
  const preset = { id: 'p', steps: [{ entry: 'a' }, { entry: 'b' }, { entry: 'c' }] };
  const out = reorderSteps(preset, ['c', 'a', 'b']);
  assert.deepEqual(out.steps.map((s) => s.entry), ['c', 'a', 'b']);
  assert.deepEqual(preset.steps.map((s) => s.entry), ['a', 'b', 'c'], '不应改原对象');
});

test('reorderSteps: 顺序集合不一致时报错（避免悄悄丢步骤）', () => {
  const preset = { id: 'p', steps: [{ entry: 'a' }, { entry: 'b' }] };
  assert.throws(() => reorderSteps(preset, ['a']), /缺少步骤/);
  assert.throws(() => reorderSteps(preset, ['a', 'b', 'c']), /不存在的步骤/);
  assert.throws(() => reorderSteps(preset, 'a,b'), /必须是数组/);
});

test('reorderSteps: 同名入口重复时按出现顺序排队', () => {
  const preset = {
    id: 'p',
    steps: [
      { entry: 'a', label: '第一次' },
      { entry: 'b' },
      { entry: 'a', label: '第二次' },
    ],
  };
  const out = reorderSteps(preset, ['a', 'a', 'b']);
  assert.deepEqual(out.steps.map((s) => s.label ?? s.entry), ['第一次', '第二次', 'b']);
});

test('toggleStep: 只改指定序号的那一条', () => {
  const preset = { id: 'p', steps: [{ entry: 'a' }, { entry: 'a' }] };
  const out = toggleStep(preset, 'a', false, 1);
  assert.equal(out.steps[0].enabled, undefined, '第 0 条不动');
  assert.equal(out.steps[1].enabled, false);
});

test('upsertPreset: 新增与覆盖', () => {
  let c = { presets: [{ id: 'a', name: 'A' }] };
  c = upsertPreset(c, { id: 'b', name: 'B' });
  assert.equal(c.presets.length, 2);
  c = upsertPreset(c, { id: 'a', name: 'A2' });
  assert.equal(c.presets.length, 2, '同 id 应覆盖而不是追加');
  assert.equal(getPreset(c, 'a').name, 'A2');
});

test('removePreset: 删除存在的与不存在的', () => {
  const c = { presets: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual(removePreset(c, 'a').presets.map((p) => p.id), ['b']);
  assert.equal(removePreset(c, 'zzz'), c, '不存在时原样返回');
});

test('uniquePresetId: 冲突时递增后缀', () => {
  const c = { presets: [{ id: 'preset' }, { id: 'preset2' }] };
  assert.equal(uniquePresetId(c, 'preset'), 'preset3');
  assert.equal(uniquePresetId(c, 'other'), 'other');
});

test('blankPreset: 用已发现的模块生成（默认全开）', () => {
  const modules = discoverModules();
  const p = blankPreset('new', '新任务', modules);
  assert.equal(p.id, 'new');
  assert.equal(p.name, '新任务');
  assert.equal(p.steps.length, modules.filter((m) => m.ok).length);
  assert.ok(p.steps.every((s) => s.enabled === true));
  assert.equal(p.schedule.enabled, false);

  const closed = blankPreset('new2', 'x', modules, { allEnabled: false });
  assert.ok(closed.steps.every((s) => s.enabled === false));
});

test('reconcilePreset: 报出失效与新增的模块', () => {
  const modules = discoverModules().filter((m) => m.ok);
  const preset = {
    id: 'p',
    steps: [{ entry: '已经不存在的模块' }, { entry: modules[0].entry }],
  };
  const r = reconcilePreset(preset, modules);
  assert.deepEqual(r.missing, ['已经不存在的模块']);
  assert.ok(!r.added.includes(modules[0].entry), '已有的不算新增');
  assert.ok(r.preset.steps.some((s) => s.entry === modules[1].entry && s.enabled === false));
});

test('hasScheduledPresets: 只有开启且带 cron 的才算', () => {
  assert.equal(hasScheduledPresets({ presets: [] }), false);
  assert.equal(
    hasScheduledPresets({ presets: [{ id: 'a', schedule: { enabled: true, cron: '' } }] }),
    false,
  );
  assert.equal(
    hasScheduledPresets({ presets: [{ id: 'a', schedule: { enabled: true, cron: '0 8 * * *' } }] }),
    true,
  );
});

// ------------------------------------------------------------ 读写（真实文件，用完还原）

test('readTaskConfig: 文件不存在时返回默认值并标记 exists=false', () => {
  const had = fs.existsSync(PATHS.tasksFile);
  const backup = had ? fs.readFileSync(PATHS.tasksFile) : null;
  fs.rmSync(PATHS.tasksFile, { force: true });
  try {
    const r = readTaskConfig();
    assert.equal(r.exists, false);
    assert.deepEqual(r.config.presets, []);
    assert.deepEqual(r.errors, []);
  } finally {
    if (backup) fs.writeFileSync(PATHS.tasksFile, backup);
  }
});

test('writeTaskConfig / readTaskConfig: 往返一致、非法内容被拒、旧文件被备份', () => {
  const had = fs.existsSync(PATHS.tasksFile);
  const backup = had ? fs.readFileSync(PATHS.tasksFile) : null;
  try {
    // 先放一份旧内容，验证会被备份
    fs.mkdirSync(PATHS.configBackups, { recursive: true });
    fs.writeFileSync(PATHS.tasksFile, '{"version":1,"presets":[]}\n');

    const cfg = goodConfig();
    const { backup: backupPath } = writeTaskConfig(cfg, { knownNodes: nodes });
    assert.ok(backupPath, '应当生成备份');
    assert.ok(fs.existsSync(backupPath));

    const r = readTaskConfig();
    assert.equal(r.exists, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.config.presets.length, 2);
    assert.deepEqual(
      r.config.presets[0].steps.map((s) => s.entry),
      ['联盟日常', '启动游戏'],
    );
    assert.equal(r.config.presets[0].steps[0].timeoutMs, 300000);
    assert.equal(r.config.presets[0].schedule.cron, '0 8 * * *');

    // 非法内容必须被拒绝，且不落盘
    const before = fs.readFileSync(PATHS.tasksFile, 'utf8');
    assert.throws(() => writeTaskConfig({ version: 1, presets: [{ id: 'BAD' }] }), /校验未通过/);
    assert.equal(fs.readFileSync(PATHS.tasksFile, 'utf8'), before, '被拒时不应改动文件');
  } finally {
    if (backup) fs.writeFileSync(PATHS.tasksFile, backup);
    else fs.rmSync(PATHS.tasksFile, { force: true });
  }
});

test('readTaskConfig: 允许 JSONC 注释', () => {
  const had = fs.existsSync(PATHS.tasksFile);
  const backup = had ? fs.readFileSync(PATHS.tasksFile) : null;
  try {
    fs.writeFileSync(
      PATHS.tasksFile,
      ['{', '  // 注释', '  "version": 1,', '  "presets": []', '}', ''].join('\n'),
    );
    const r = readTaskConfig();
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.config.presets, []);
  } finally {
    if (backup) fs.writeFileSync(PATHS.tasksFile, backup);
    else fs.rmSync(PATHS.tasksFile, { force: true });
  }
});

test('readTaskConfig: 坏 JSON 报错但不抛异常', () => {
  const had = fs.existsSync(PATHS.tasksFile);
  const backup = had ? fs.readFileSync(PATHS.tasksFile) : null;
  try {
    fs.writeFileSync(PATHS.tasksFile, '{ 不是 json');
    const r = readTaskConfig();
    assert.ok(r.errors.some((e) => e.includes('解析失败')), JSON.stringify(r.errors));
    assert.deepEqual(r.config.presets, [], '仍然给一份可用的默认配置');
  } finally {
    if (backup) fs.writeFileSync(PATHS.tasksFile, backup);
    else fs.rmSync(PATHS.tasksFile, { force: true });
  }
});
