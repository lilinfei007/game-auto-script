import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  PIPELINE_BASE_RE,
  RECOGNITION_TYPES,
  ACTION_TYPES,
  stripRefDecorators,
  refDecoratorOf,
  normalizeRefs,
  validatePipelineDoc,
  listPipelineDocs,
  buildNodeIndex,
  readPipelineDoc,
  resolveWritablePipeline,
  writePipelineDoc,
  pipelineStats,
} from '../src/pipeline-edit.mjs';
import { PATHS } from '../src/config.mjs';

const nodes = ['启动游戏', '等待游戏加载', '确认主界面', '回到主界面', '通用弹窗处理'];

/** 一份合法流水线。 */
function goodDoc() {
  return {
    启动游戏: {
      recognition: { type: 'DirectHit', param: {} },
      action: { type: 'StartApp', param: { package: 'com.gof.china' } },
      next: ['[JumpBack]通用弹窗处理', '等待游戏加载'],
    },
    等待游戏加载: {
      recognition: { type: 'OCR', param: { expected: '^野外$', roi: [595, 1225, 125, 55] } },
      action: { type: 'Click', param: {} },
      timeout: 120000,
      post_delay: 1000,
      max_hit: 3,
      next: ['确认主界面'],
      on_error: ['回到主界面'],
    },
    确认主界面: { recognition: { type: 'DirectHit', param: {} }, action: { type: 'DoNothing', param: {} }, next: [] },
  };
}

const errPaths = (r) => r.errors.map((e) => e.path);
const errText = (r) => r.errors.map((e) => `${e.path}:${e.message}`).join(' | ');

// ------------------------------------------------------------ 节点属性前缀

test('stripRefDecorators / refDecoratorOf: 正确剥掉节点属性前缀', () => {
  assert.equal(stripRefDecorators('[JumpBack]通用弹窗处理'), '通用弹窗处理');
  assert.equal(stripRefDecorators('[Anchor]我的锚点'), '我的锚点');
  assert.equal(stripRefDecorators('普通节点'), '普通节点');
  assert.equal(stripRefDecorators(''), '');
  assert.equal(stripRefDecorators(null), '');
  // 只剥一层、只剥方括号里的字母属性
  assert.equal(stripRefDecorators('[JumpBack][Anchor]X'), '[Anchor]X');

  assert.equal(refDecoratorOf('[JumpBack]X'), 'JumpBack');
  assert.equal(refDecoratorOf('[Anchor]X'), 'Anchor');
  assert.equal(refDecoratorOf('X'), '');
  assert.equal(refDecoratorOf(123), '');
});

test('normalizeRefs: 字符串、数组、NodeAttr 对象、非法项都能归类', () => {
  assert.deepEqual(normalizeRefs(undefined), []);
  assert.deepEqual(normalizeRefs([]), []);

  const one = normalizeRefs('[JumpBack]A');
  assert.equal(one.length, 1);
  assert.equal(one[0].name, 'A');
  assert.equal(one[0].decorator, 'JumpBack');

  const many = normalizeRefs(['A', '[Anchor]B']);
  assert.deepEqual(many.map((r) => r.name), ['A', 'B']);

  const objForm = normalizeRefs([{ name: '[JumpBack]C' }]);
  assert.equal(objForm[0].name, 'C');
  assert.equal(objForm[0].form, 'object');

  assert.equal(normalizeRefs([42])[0].form, 'invalid');
});

test('RECOGNITION_TYPES / ACTION_TYPES: 覆盖协议里的类型', () => {
  for (const t of ['DirectHit', 'TemplateMatch', 'OCR', 'And', 'Or', 'Custom']) {
    assert.ok(RECOGNITION_TYPES.has(t), `识别类型缺 ${t}`);
  }
  for (const t of ['DoNothing', 'Click', 'Swipe', 'ClickKey', 'StartApp', 'Custom', 'Shell', 'Screencap']) {
    assert.ok(ACTION_TYPES.has(t), `动作类型缺 ${t}`);
  }
});

// ------------------------------------------------------------ 校验：正常

test('validatePipelineDoc: 合法文档零错误零警告', () => {
  const r = validatePipelineDoc(goodDoc(), { knownNodes: nodes });
  assert.deepEqual(r.errors, [], errText(r));
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

test('validatePipelineDoc: 接受 v1 扁平写法，但提醒改用 v2', () => {
  const doc = { A: { recognition: 'OCR', action: 'Click', next: [] } };
  const r = validatePipelineDoc(doc);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.message.includes('v1 扁平')), JSON.stringify(r.warnings));
});

test('validatePipelineDoc: 不传 knownNodes 时不做引用校验', () => {
  const doc = { A: { next: ['不存在的节点'] } };
  assert.deepEqual(validatePipelineDoc(doc).errors, []);
  assert.ok(validatePipelineDoc(doc, { knownNodes: nodes }).errors.length > 0);
});

// ------------------------------------------------------------ 校验：结构

test('validatePipelineDoc: 顶层与节点定义的形态错误', () => {
  for (const [input, needle] of [
    [null, '顶层'],
    [[], '顶层'],
    ['x', '顶层'],
    [{ A: 1 }, '节点定义必须是对象'],
    [{ A: [] }, '节点定义必须是对象'],
    [{ '': {} }, '节点名不能为空'],
  ]) {
    const r = validatePipelineDoc(input);
    assert.ok(errText(r).includes(needle), `${JSON.stringify(input)} 期望含「${needle}」，实际 ${errText(r)}`);
  }
});

test('validatePipelineDoc: 未知字段给警告而不是错误（框架会忽略）', () => {
  const doc = { A: { action: { type: 'DoNothing', param: {} }, 我瞎写的: 1, next: [] } };
  const r = validatePipelineDoc(doc, { knownNodes: nodes });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.message.includes('未知字段')), JSON.stringify(r.warnings));
  // $ 开头的自定义字段协议允许，连警告都不要
  const ok = validatePipelineDoc({ A: { $自定义: 1 } }, { knownNodes: nodes });
  assert.deepEqual(ok.warnings, []);
});

test('validatePipelineDoc: 不给 knownNodes 时明确警告「跳过了引用校验」', () => {
  // 回归：早先静默跳过，使用者以为「校验过了」，坏引用照样落盘
  const r = validatePipelineDoc({ A: { next: ['不存在的节点'] } });
  assert.deepEqual(r.errors, [], '没给节点表就不该报引用错误');
  assert.ok(
    r.warnings.some((w) => w.message.includes('跳过引用完整性校验')),
    `应当明确提示跳过，实际 ${JSON.stringify(r.warnings)}`,
  );
});

test('validatePipelineDoc: 字段类型错误逐项指出', () => {
  const cases = [
    ['timeout', 1.5, 'timeout'],
    ['timeout', 'x', 'timeout'],
    ['pre_delay', -1, 'pre_delay'],
    ['post_delay', -1, 'post_delay'],
    ['rate_limit', -5, 'rate_limit'],
    ['max_hit', -1, 'max_hit'],
    ['enabled', 'yes', 'enabled'],
    ['inverse', 1, 'inverse'],
    ['attach', [], 'attach'],
    ['focus', 'x', 'focus'],
    ['pre_wait_freezes', -1, 'pre_wait_freezes'],
    ['next', 42, 'next'],
    ['on_error', 42, 'on_error'],
    ['anchor', 42, 'anchor'],
  ];
  for (const [field, value, needle] of cases) {
    const doc = { A: { [field]: value } };
    const r = validatePipelineDoc(doc);
    assert.ok(
      errPaths(r).some((p) => p === `A.${needle}`),
      `${field}=${JSON.stringify(value)} 期望报在 A.${needle}，实际 ${errText(r)}`,
    );
  }
});

test('validatePipelineDoc: timeout=-1 合法（v5.5 无限等待）', () => {
  const r = validatePipelineDoc({ A: { timeout: -1 } });
  assert.deepEqual(r.errors, [], errText(r));
});

test('validatePipelineDoc: 废弃字段给警告', () => {
  const r = validatePipelineDoc({ A: { is_sub: true, interrupt: 'B' } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.filter((w) => w.message.includes('废弃')).length, 2);
});

// ------------------------------------------------------------ 校验：识别与动作

test('validatePipelineDoc: 未知识别/动作类型报错', () => {
  const bad = validatePipelineDoc({ A: { recognition: { type: 'Ocr', param: {} } } });
  assert.ok(errText(bad).includes('未知的识别类型'), errText(bad));

  const bad2 = validatePipelineDoc({ A: { action: { type: 'Tap', param: {} } } });
  assert.ok(errText(bad2).includes('未知的动作类型'), errText(bad2));
});

test('validatePipelineDoc: Custom 必须给名字，名字不在注册表只警告', () => {
  const missing = validatePipelineDoc({
    A: { recognition: { type: 'Custom', param: {} }, action: { type: 'Custom', param: {} } },
  });
  assert.ok(errText(missing).includes('custom_recognition'), errText(missing));
  assert.ok(errText(missing).includes('custom_action'), errText(missing));

  const known = validatePipelineDoc(
    {
      A: {
        recognition: { type: 'Custom', param: { custom_recognition: 'wjdr_read_count' } },
        action: { type: 'Custom', param: { custom_action: 'wjdr_ensure_home' } },
      },
    },
    {
      knownNodes: nodes,
      customRecognitions: ['wjdr_read_count'],
      customActions: ['wjdr_ensure_home'],
    },
  );
  assert.deepEqual(known.errors, []);
  assert.deepEqual(known.warnings, []);

  const typo = validatePipelineDoc(
    { A: { recognition: { type: 'Custom', param: { custom_recognition: 'wjdr_read_cout' } } } },
    { knownNodes: nodes, customRecognitions: ['wjdr_read_count'], customActions: [] },
  );
  assert.deepEqual(typo.errors, [], '拼错名字不应该拦住保存');
  assert.ok(typo.warnings.some((w) => w.message.includes('没有注册')), JSON.stringify(typo.warnings));
});

test('validatePipelineDoc: param 里的 roi / expected / 数值字段', () => {
  assert.ok(errText(validatePipelineDoc({ A: { recognition: { type: 'OCR', param: { roi: [1, 2, 3] } } } })).includes('4 个整数'));
  assert.ok(errText(validatePipelineDoc({ A: { recognition: { type: 'OCR', param: { roi: [1, 2, 3, 'x'] } } } })).includes('4 个整数'));
  // 协议 v5.6 起允许负数坐标
  assert.deepEqual(validatePipelineDoc({ A: { recognition: { type: 'OCR', param: { roi: [-1, -2, 10, 10] } } } }).errors, []);

  assert.ok(errText(validatePipelineDoc({ A: { recognition: { type: 'OCR', param: { expected: '(' } } } })).includes('正则'));
  assert.ok(errText(validatePipelineDoc({ A: { recognition: { type: 'TemplateMatch', param: { threshold: 'x' } } } })).includes('数字'));
  assert.ok(errText(validatePipelineDoc({ A: { action: { type: 'ClickKey', param: { key: 4.5 } } } })).includes('整数'));
});

test('validatePipelineDoc: param.package 占位符只警告', () => {
  const r = validatePipelineDoc({
    A: { action: { type: 'StartApp', param: { package: 'TODO_SET_ME' } } },
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.message.includes('占位符')), JSON.stringify(r.warnings));
});

// ------------------------------------------------------------ 校验：引用

test('validatePipelineDoc: next/on_error 引用不存在的节点会报错并给 JSON 路径', () => {
  const doc = { A: { next: ['不存在的节点'], on_error: ['也没有这个'] } };
  const r = validatePipelineDoc(doc, { knownNodes: nodes });
  assert.ok(errPaths(r).includes('A.next'), errText(r));
  assert.ok(errPaths(r).includes('A.on_error'), errText(r));
  assert.ok(errText(r).includes('引用的节点不存在'), errText(r));
});

test('validatePipelineDoc: [JumpBack] 前缀必须先剥掉再查引用（回归）', () => {
  // 这是最容易踩的坑：不剥前缀会把正确的引用误报成「节点不存在」
  const doc = { A: { next: ['[JumpBack]通用弹窗处理'] } };
  const r = validatePipelineDoc(doc, { knownNodes: nodes });
  assert.deepEqual(r.errors, [], errText(r));
});

test('validatePipelineDoc: 引用本文件内的节点也算存在', () => {
  const r = validatePipelineDoc(goodDoc(), { knownNodes: [] });
  assert.ok(errText(r).includes('等待游戏加载'), '不给 knownNodes 时本文件节点也应被认可');
});

test('validatePipelineDoc: [Anchor] 引用按锚点处理，不查节点表', () => {
  const doc = { A: { next: ['[Anchor]某锚点'] } };
  const r = validatePipelineDoc(doc, { knownNodes: nodes });
  assert.deepEqual(r.errors, [], errText(r));
  assert.ok(r.warnings.some((w) => w.message.includes('锚点')), JSON.stringify(r.warnings));
});

test('validatePipelineDoc: NodeAttr 对象形式的引用也能校验', () => {
  const ok = validatePipelineDoc({ A: { next: [{ name: '[JumpBack]通用弹窗处理' }] } }, { knownNodes: nodes });
  assert.deepEqual(ok.errors, [], errText(ok));

  const bad = validatePipelineDoc({ A: { next: [{ name: '不存在' }] } }, { knownNodes: nodes });
  assert.ok(errText(bad).includes('引用的节点不存在'), errText(bad));

  const empty = validatePipelineDoc({ A: { next: [{ name: '' }] } }, { knownNodes: nodes });
  assert.ok(errText(empty).includes('节点名为空'), errText(empty));

  const weird = validatePipelineDoc({ A: { next: [42] } });
  assert.ok(errText(weird).includes('字符串或'), errText(weird));
});

test('validatePipelineDoc: 极短 timeout 给出易错提醒', () => {
  const r = validatePipelineDoc({ A: { timeout: 100 } });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.message.includes('next 列表')), JSON.stringify(r.warnings));
});

test('validatePipelineDoc: $ 开头的节点名会被框架跳过 → 警告', () => {
  const r = validatePipelineDoc({ $内部: {} });
  assert.ok(r.warnings.some((w) => w.message.includes('$')), JSON.stringify(r.warnings));
});

test('validatePipelineDoc: 空文件只给警告', () => {
  const r = validatePipelineDoc({});
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.message.includes('没有任何节点')));
});

// ------------------------------------------------------------ 读取与索引

test('listPipelineDocs: 列出仓库里的流水线并标记共享文件', () => {
  const docs = listPipelineDocs();
  assert.ok(docs.length >= 4, `应当至少 4 个文件，实际 ${docs.length}`);
  const common = docs.find((d) => d.base === '_common');
  assert.ok(common, '应当有 _common');
  assert.equal(common.shared, true);
  for (const d of docs) {
    assert.equal(d.shared, d.base.startsWith('_'));
    assert.ok(Array.isArray(d.nodes));
  }
});

test('buildNodeIndex: 给出节点归属与被引用关系', () => {
  const index = buildNodeIndex();
  assert.ok(index.total > 5, `节点总数应当 > 5，实际 ${index.total}`);

  const back = index.nodes.find((n) => n.node === '回到主界面');
  assert.ok(back, '仓库里应当有「回到主界面」');
  assert.ok(back.referencedBy.length > 0, '「回到主界面」应当被别的节点引用');
  for (const ref of back.referencedBy) {
    assert.ok(ref.base && ref.node && ['next', 'on_error'].includes(ref.field));
  }
});

test('readPipelineDoc: 读回真实文件，带 mtime 与节点列表', () => {
  const doc = readPipelineDoc('_common');
  assert.ok(doc, '_common 应当能读到');
  assert.equal(doc.ok, true);
  assert.match(doc.text, /回到主界面/);
  assert.ok(doc.mtime > 0);
  assert.ok(doc.nodes.includes('回到主界面'));
  assert.equal(readPipelineDoc('绝对不存在的文件'), null);
});

test('pipelineStats: 汇总文档与孤立节点', () => {
  const stats = pipelineStats();
  assert.ok(stats.docs.length >= 4);
  assert.ok(stats.totalNodes > 5);
  assert.ok(Array.isArray(stats.orphans));
  assert.ok(stats.docs.every((d) => Number.isInteger(d.refCount)));
});

// ------------------------------------------------------------ 安全写入

test('PIPELINE_BASE_RE: 拒绝点号与路径分隔符', () => {
  for (const ok of ['00_启动游戏', '10_联盟日常', '_common', 'a-b_c', 'A1']) {
    assert.equal(PIPELINE_BASE_RE.test(ok), true, `${ok} 应当合法`);
  }
  for (const bad of ['../secret', 'a/b', 'a\\b', 'a.json', '..', '.', '', 'x'.repeat(65), 'a b']) {
    assert.equal(PIPELINE_BASE_RE.test(bad), false, `${bad} 应当非法`);
  }
});

test('resolveWritablePipeline: 路径穿越与非法名一律拒绝', () => {
  for (const bad of ['../package', '/etc/passwd', 'a/b', 'a.json', '', null, 42]) {
    assert.throws(() => resolveWritablePipeline(bad), /流水线名非法/, `${bad} 应当被拒绝`);
  }
  assert.throws(() => resolveWritablePipeline('不存在这个文件'), /不存在/);
  const r = resolveWritablePipeline('_common');
  assert.ok(path.resolve(r.target).startsWith(path.resolve(PATHS.pipeline) + path.sep));
});

test('writePipelineDoc: 校验不过时拒绝落盘，文件保持原样', () => {
  const target = path.join(PATHS.pipeline, '_common.json');
  const before = fs.readFileSync(target, 'utf8');

  assert.throws(
    () => writePipelineDoc('_common', JSON.stringify({ A: { next: ['不存在的节点'] } }), { knownNodes: nodes }),
    /校验未通过/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), before, '被拒时不应改动文件');

  assert.throws(() => writePipelineDoc('_common', '{ 不是 json'), /不是合法 JSON/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('writePipelineDoc: 正常保存、生成备份、返回节点列表', () => {
  const target = path.join(PATHS.pipeline, '_common.json');
  const before = fs.readFileSync(target, 'utf8');
  const beforeMtime = fs.statSync(target).mtimeMs;
  // 用一份内容不同但结构与原文件等价的文档，避免破坏后续用例
  const doc = JSON.parse(before);
  doc['临时探针节点'] = {
    recognition: { type: 'DirectHit', param: {} },
    action: { type: 'DoNothing', param: {} },
    next: [],
  };

  try {
    const r = writePipelineDoc('_common', JSON.stringify(doc, null, 2), { knownNodes: nodes, expectedMtime: beforeMtime });
    assert.ok(r.backup, '应当生成备份');
    assert.ok(fs.existsSync(r.backup));
    assert.ok(r.nodes.includes('临时探针节点'));

    const after = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(after['临时探针节点'], '新节点应当写进去了');
  } finally {
    fs.writeFileSync(target, before);
  }
});

test('writePipelineDoc: mtime 冲突时拒绝（防覆盖外部编辑）', () => {
  const target = path.join(PATHS.pipeline, '_common.json');
  const before = fs.readFileSync(target, 'utf8');
  try {
    assert.throws(
      () => writePipelineDoc('_common', before, { expectedMtime: 1 }),
      /已被外部修改/,
    );
  } finally {
    fs.writeFileSync(target, before);
  }
});

test('writePipelineDoc: 原文件有注释时提醒注释会丢失', () => {
  const dir = PATHS.pipeline;
  const base = '__probe_jsonc';
  const file = path.join(dir, `${base}.jsonc`);
  fs.writeFileSync(file, '{\n  // 这是注释\n  "A": { "next": [] }\n}\n');
  try {
    const r = writePipelineDoc(base, JSON.stringify({ A: { next: [] } }, null, 2));
    assert.ok(r.warnings.some((w) => w.message.includes('注释')), JSON.stringify(r.warnings));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('writePipelineDoc: 写入的内容末尾会补换行', () => {
  const base = '__probe_newline';
  const file = path.join(PATHS.pipeline, `${base}.json`);
  fs.writeFileSync(file, '{"A":{"next":[]}}');
  try {
    writePipelineDoc(base, '{"A":{"next":[]}}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"A":{"next":[]}}\n');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
