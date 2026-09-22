#!/usr/bin/env node
/**
 * 把截图「读成文字」—— 对图片跑一次 OCR 并打印所有识别结果。
 *
 * 用途：
 *  1. 验证截图是否真的是游戏画面（不是黑屏/模拟器桌面）；
 *  2. 在没有图形界面、或所用模型不支持读图时，也能知道界面上有什么文字，
 *     从而直接写出 pipeline 的 `expected` 正则与 roi 坐标。
 *
 * 用法：
 *   node tools/ocr-dump.mjs debug/doctor.png
 *   node tools/ocr-dump.mjs shot.png --roi 0,900,720,380
 *   node tools/ocr-dump.mjs shot.png --expected "确定|取消"
 *   node tools/ocr-dump.mjs debug/doctor.png --json
 */
import fs from 'node:fs';
import path from 'node:path';
import maa from '@maaxyz/maa-node';
import { loadConfig } from '../src/config.mjs';
import { createResource } from '../src/resource.mjs';
import { createLogger, setLevel } from '../src/util/log.mjs';
import { initRuntime } from '../src/runtime.mjs';
import { readImageSize } from '../src/util/image.mjs';
import { allOf, recognizeWithTasker } from '../src/util/detail.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function parseRoi(text) {
  if (!text || text === true) return [0, 0, 0, 0];
  const parts = String(text).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--roi 需要 4 个数字 x,y,w,h，收到 "${text}"`);
  }
  return parts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    console.error('用法: node tools/ocr-dump.mjs <图片路径> [--roi x,y,w,h] [--expected 正则] [--json]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`文件不存在: ${file}`);
    process.exit(2);
  }

  setLevel('warn');
  const logger = createLogger('ocr');

  const { config, errors } = loadConfig();
  if (errors.length) {
    console.error(`配置错误: ${errors.join('; ')}`);
    process.exit(2);
  }
  // tools 也要初始化框架日志，否则排障时框架日志为空
  initRuntime(config, logger, { stdoutLevel: 'Warn' });

  const buf = fs.readFileSync(file);
  const size = readImageSize(buf);
  const image = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const roi = parseRoi(args.roi);
  const expected = typeof args.expected === 'string' ? args.expected : '';

  console.log(`图片: ${file}`);
  console.log(`尺寸: ${size ? `${size.width}x${size.height} (${size.format})` : '未知'}`);
  console.log(`ROI : [${roi.join(', ')}]${roi[2] === 0 && roi[3] === 0 ? ' (全图)' : ''}`);
  console.log(`期望: ${expected || '(全部)'}`);
  console.log('');

  const { resource } = await createResource(config, logger);

  const tasker = new maa.Tasker();
  tasker.resource = resource;
  if (!tasker.inited) throw new Error('Tasker 初始化失败');

  const reco = await recognizeWithTasker(tasker, 'OCR', { roi, expected }, image);
  if (!reco) {
    console.error('OCR 识别失败（检查 resource/model/ocr 是否完整）');
    process.exit(1);
  }
  const all = allOf(reco);

  if (all.length === 0) {
    console.log('(没有识别到任何文字)');
    console.log('提示：若这是游戏画面，可能是文字较小或背景复杂，可尝试放大 roi 或检查 OCR 模型。');
    process.exit(0);
  }

  if (args.json) {
    console.log(JSON.stringify(all, null, 2));
  } else {
    // 按屏幕阅读顺序（先上后下、先左后右）排列，便于还原界面
    const sorted = [...all].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    console.log(`共 ${all.length} 条：\n`);
    console.log('  序号  box[x,y,w,h]              score  文本');
    console.log('  ' + '-'.repeat(64));
    sorted.forEach((item, i) => {
      const box = `[${item.box.join(',')}]`.padEnd(24);
      const score = (item.score ?? 0).toFixed(3);
      console.log(`  ${String(i + 1).padStart(4)}  ${box}  ${score}  ${item.text}`);
    });
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(`失败: ${e.message}`);
  process.exit(1);
});
