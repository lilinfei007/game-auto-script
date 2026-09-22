/**
 * 录制/回放自检（端到端）。
 *
 *   node tools/selftest-replay.mjs                录制 + 离线回放，两步都要成功
 *   node tools/selftest-replay.mjs --replay-only  跳过录制，直接回放已有文件（不需要模拟器）
 *
 * 用的是 resource/pipeline/_replaytest.json —— 一条刻意做得短小、确定的流水线
 * （点击 → 按键 → 两次截图 → 再点击），所以回放能完整复现。
 * 真实业务流水线里有「识别不到就反复截图重试」的长等待段落，回放次数对不上会错位，
 * 那是回放机制本身的限制，不是这个自检要覆盖的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, PATHS } from '../src/config.mjs';
import { createController } from '../src/controller.mjs';
import { createResource } from '../src/resource.mjs';
import { createTasker, buildPipelineOverride, runTasks } from '../src/runner.mjs';
import { createLogger, setLevel } from '../src/util/log.mjs';
import {
  normalizeRecording,
  createRecordController,
  createReplayController,
  analyzeRecording,
  readRecording,
  normalizeRecords,
} from '../src/replay.mjs';

const replayOnly = process.argv.includes('--replay-only');
const TASK = '回放测试';
const REC = path.join(PATHS.recording, 'selftest.rec');

setLevel('info');
const { config } = loadConfig();
const logger = createLogger('selftest');
const inst = config.instances[0];

let failed = 0;
const check = (ok, msg) => {
  logger.info(`${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- 录制
if (!replayOnly) {
  logger.info('=== 1/3 录制 ===');
  const { controller: inner } = await createController(config, inst, logger);
  fs.rmSync(REC, { force: true });
  const recorder = createRecordController(inner, REC, config);
  await recorder.post_connection().wait().succeeded;

  const { resource } = await createResource(config, logger);
  const tasker = createTasker(recorder, resource, logger);
  const r = await runTasks(tasker, recorder, [TASK], config, logger, buildPipelineOverride(config));
  check(r.ok, `录制运行 ${TASK}（${r.results[0]?.elapsed ?? '?'}s）`);
  check(fs.existsSync(REC), `生成录制文件 ${REC}`);
} else {
  logger.info('=== 1/3 录制（已跳过 --replay-only）===');
  if (!fs.existsSync(REC)) {
    logger.error(`没有可回放的录制文件：${REC}（先跑一次不带 --replay-only 的自检）`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 归一化
logger.info('');
logger.info('=== 2/3 归一化 ===');
const { records: raw } = readRecording(REC);
const { records: normalized, merged } = normalizeRecords(raw);
const report = analyzeRecording(normalized, path.dirname(REC));
const norm = normalizeRecording(REC);
logger.info(`原始 ${raw.length} 条 → 回放用 ${normalized.length} 条`);
logger.info(`合并：click ×${merged.click}，click_key ×${merged.click_key}`);
logger.info(`类型：${Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

// 这条流水线是确定的，应当正好是 2 次点击 + 1 次按键
check(merged.click === 2, `click 合并数 = 2（实际 ${merged.click}）`);
check(merged.click_key === 1, `click_key 合并数 = 1（实际 ${merged.click_key}）`);
check(report.missingShots.length === 0, `截图齐全（缺 ${report.missingShots.length} 张）`);
check(report.longestScreencapRun < 10, `无长等待段落（最长连续截图 ${report.longestScreencapRun}）`);
check(fs.existsSync(norm.dst), `归一化文件已写出 ${norm.dst}`);

// ---------------------------------------------------------------- 回放
logger.info('');
logger.info('=== 3/3 离线回放（不连接模拟器）===');
const { resource } = await createResource(config, logger);
const replayer = createReplayController(norm.dst, config);
const connected = await replayer.post_connection().wait().succeeded;
check(connected, '回放控制器连接成功');

if (connected) {
  const tasker = createTasker(replayer, resource, logger);
  const r = await runTasks(tasker, replayer, [TASK], config, logger, buildPipelineOverride(config));
  check(r.ok, `离线回放 ${TASK}（${r.results[0]?.elapsed ?? '?'}s）`);
  if (!r.ok) logger.error(`  原因：${r.results[0]?.reason}`);
}

logger.info('');
logger.info(failed === 0 ? '自检通过' : `自检失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
