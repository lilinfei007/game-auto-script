import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  readRecording,
  writeRecording,
  normalizeRecords,
  normalizeRecording,
  normalizedPathOf,
  screenshotDirOf,
  analyzeRecording,
  defaultRecordingPath,
  createReplayController,
} from '../src/replay.mjs';
import { PATHS } from '../src/config.mjs';

// 用 debug/ 下的临时目录，避免污染真实产物
const TMP = fs.mkdtempSync(path.join(PATHS.debug, 'test-replay-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const rec = (type, extra = {}) => ({ type, cost: 1, success: true, timestamp: 1, ...extra });

// ------------------------------------------------------------ JSON Lines

test('readRecording: 解析 JSON Lines，坏行计入 badLines 而不是抛错', () => {
  const f = path.join(TMP, 'a.rec');
  fs.writeFileSync(f, [JSON.stringify(rec('connect')), '{ 坏行', '', JSON.stringify(rec('screencap'))].join('\n'));
  const { records, badLines } = readRecording(f);
  assert.equal(records.length, 2);
  assert.equal(badLines, 1);
  assert.equal(records[0].type, 'connect');
});

test('readRecording: 文件不存在时抛错', () => {
  assert.throws(() => readRecording(path.join(TMP, '不存在.rec')), /不存在/);
});

test('writeRecording: 写出后能原样读回', () => {
  const f = path.join(TMP, 'nested', 'b.rec');
  writeRecording(f, [rec('click', { x: 1, y: 2 })]);
  const { records } = readRecording(f);
  assert.deepEqual(records, [rec('click', { x: 1, y: 2 })]);
});

// ------------------------------------------------------------ 归一化

test('normalizeRecords: touch_down+touch_up 合并成 click', () => {
  const { records, merged } = normalizeRecords([
    rec('touch_down', { x: 544, y: 1260, pressure: 1, contact: 0 }),
    rec('touch_up', { x: 0, y: 0, pressure: 0, contact: 0 }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'click');
  assert.equal(records[0].x, 544);
  assert.equal(records[0].y, 1260);
  assert.equal(records[0].cost, 2, 'cost 应累加');
  assert.equal(merged.click, 1);
});

test('normalizeRecords: key_down+key_up 合并成 click_key', () => {
  const { records, merged } = normalizeRecords([
    rec('key_down', { keycode: 4 }),
    rec('key_up', { keycode: 4 }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'click_key');
  assert.equal(records[0].keycode, 4);
  assert.equal(merged.click_key, 1);
});

test('normalizeRecords: 键码不同的 key_down/key_up 不合并', () => {
  const { records } = normalizeRecords([
    rec('key_down', { keycode: 4 }),
    rec('key_up', { keycode: 5 }),
  ]);
  assert.deepEqual(records.map((r) => r.type), ['key_down', 'key_up']);
});

test('normalizeRecords: 中间有 touch_move 的拖拽不合并（否则会丢掉滑动）', () => {
  const { records, merged } = normalizeRecords([
    rec('touch_down', { x: 1, y: 1 }),
    rec('touch_move', { x: 50, y: 50 }),
    rec('touch_up', { x: 90, y: 90 }),
  ]);
  assert.deepEqual(records.map((r) => r.type), ['touch_down', 'touch_move', 'touch_up']);
  assert.equal(merged.click, 0);
});

test('normalizeRecords: screencap 与其它类型原样保留，顺序不变', () => {
  const input = [
    rec('connect'),
    rec('screencap', { path: 'x-Screenshot/screencap_0.png' }),
    rec('touch_down', { x: 1, y: 2 }),
    rec('touch_up', {}),
    rec('screencap', { path: 'x-Screenshot/screencap_1.png' }),
  ];
  const { records } = normalizeRecords(input);
  assert.deepEqual(records.map((r) => r.type), ['connect', 'screencap', 'click', 'screencap']);
});

test('normalizeRecords: 不修改传入的数组与对象', () => {
  const input = [rec('touch_down', { x: 1, y: 2 }), rec('touch_up', {})];
  const snapshot = JSON.parse(JSON.stringify(input));
  normalizeRecords(input);
  assert.deepEqual(input, snapshot, '原数组不应被改动');
});

test('normalizeRecords: 落单的 touch_down 不会被吞掉', () => {
  const { records } = normalizeRecords([rec('touch_down', { x: 1, y: 2 }), rec('screencap')]);
  assert.deepEqual(records.map((r) => r.type), ['touch_down', 'screencap']);
});

test('normalizeRecords: 多条 down/up 依次合并', () => {
  const { records, merged } = normalizeRecords([
    rec('touch_down', { x: 1, y: 1 }),
    rec('touch_up', {}),
    rec('key_down', { keycode: 4 }),
    rec('key_up', { keycode: 4 }),
    rec('touch_down', { x: 2, y: 2 }),
    rec('touch_up', {}),
  ]);
  assert.deepEqual(records.map((r) => r.type), ['click', 'click_key', 'click']);
  assert.equal(merged.click, 2);
  assert.equal(merged.click_key, 1);
});

// ------------------------------------------------------------ 路径

test('normalizedPathOf: 与原文件同目录，避免截图相对路径失效', () => {
  const src = path.join('D:', 'x', 'run.rec');
  const dst = normalizedPathOf(src);
  assert.equal(path.dirname(dst), path.dirname(src), '必须同目录');
  assert.match(dst, /run\.replay\.rec$/);
});

test('screenshotDirOf: 与框架一致，是 <文件名去掉扩展名>-Screenshot', () => {
  assert.equal(
    screenshotDirOf(path.join('D:', 'x', 'mini.rec')),
    path.join('D:', 'x', 'mini-Screenshot'),
  );
});

test('defaultRecordingPath: 落在 debug/recording 下', () => {
  const p = defaultRecordingPath('20260101-000000');
  assert.equal(path.dirname(p), PATHS.recording);
  assert.match(path.basename(p), /^20260101-000000\.rec$/);
});

// ------------------------------------------------------------ 体检

test('analyzeRecording: 统计类型并找最长连续截图段', () => {
  const records = [
    rec('connect'),
    rec('screencap'),
    rec('click'),
    rec('screencap'),
    rec('screencap'),
    rec('screencap'),
    rec('click'),
    rec('screencap'),
  ];
  const a = analyzeRecording(records, TMP);
  assert.equal(a.total, 8);
  assert.equal(a.counts.screencap, 5);
  assert.equal(a.counts.click, 2);
  assert.equal(a.longestScreencapRun, 3);
  assert.equal(a.longestScreencapStart, 3);
});

test('analyzeRecording: 连续截图 ≥10 次时告警（回放易错位）', () => {
  const records = [rec('connect'), ...Array.from({ length: 12 }, () => rec('screencap'))];
  const a = analyzeRecording(records, TMP);
  assert.equal(a.longestScreencapRun, 12);
  assert.ok(a.warnings.some((w) => /连续截图 12 次/.test(w)), JSON.stringify(a.warnings));
});

test('analyzeRecording: 截图缺失会被列出来', () => {
  const records = [rec('screencap', { path: 'missing-Screenshot/nope.png' })];
  const a = analyzeRecording(records, TMP);
  assert.deepEqual(a.missingShots, ['missing-Screenshot/nope.png']);
  assert.ok(a.warnings.some((w) => /截图缺失/.test(w)));
});

test('analyzeRecording: 截图存在时不告警缺失', () => {
  const shotDir = path.join(TMP, 'ok-Screenshot');
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, 'screencap_0.png'), 'x');
  const a = analyzeRecording([rec('screencap', { path: 'ok-Screenshot/screencap_0.png' })], TMP);
  assert.deepEqual(a.missingShots, []);
});

test('analyzeRecording: 残留未合并的 down 会被提醒', () => {
  const a = analyzeRecording([rec('touch_down', { x: 1, y: 1 })], TMP);
  assert.equal(a.unmergedDowns, 1);
  assert.ok(a.warnings.some((w) => /未合并/.test(w)));
});

// ------------------------------------------------------------ 端到端

test('normalizeRecording: 读→归一化→写出→体检 一条龙', () => {
  const src = path.join(TMP, 'e2e.rec');
  const shotDir = path.join(TMP, 'e2e-Screenshot');
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, 'screencap_0.png'), 'x');

  writeRecording(src, [
    rec('connect'),
    rec('screencap', { path: 'e2e-Screenshot/screencap_0.png' }),
    rec('touch_down', { x: 10, y: 20 }),
    rec('touch_up', { x: 0, y: 0 }),
    rec('key_down', { keycode: 4 }),
    rec('key_up', { keycode: 4 }),
  ]);

  const r = normalizeRecording(src);
  assert.equal(r.before.total, 6);
  assert.equal(r.after.total, 4);
  assert.equal(r.merged.click, 1);
  assert.equal(r.merged.click_key, 1);
  assert.equal(r.after.missingShots.length, 0, '截图在同目录，应当能找到');
  assert.deepEqual(r.after.warnings, []);
  assert.ok(fs.existsSync(r.dst), '归一化文件应已写出');

  // 归一化文件里的相对路径仍然指向同目录的截图
  const back = readRecording(r.dst);
  assert.equal(back.records.find((x) => x.type === 'screencap').path, 'e2e-Screenshot/screencap_0.png');
});

test('createReplayController: 文件不存在时抛错', () => {
  assert.throws(
    () => createReplayController(path.join(TMP, '没有这个.rec'), { runtime: {} }),
    /不存在/,
  );
});
