#!/usr/bin/env node
/**
 * 界面探索器：**点一下 → 等一下 → 截图 → 像素统计 → OCR 读屏**，一步完成。
 *
 * 这是编写任务模块的主要工具：每个 pipeline 节点的 `roi` 与 `expected`
 * 都应当由这里的实测输出推导，而不是靠猜。
 *
 * 用法：
 *   node tools/explore.mjs                                  # 只看当前画面
 *   node tools/explore.mjs --tap 648,1255                   # 点「野外」再看
 *   node tools/explore.mjs --tap "648,1255;360,700"         # 连续点两处
 *   node tools/explore.mjs --key 4 --wait 1500              # 按返回键
 *   node tools/explore.mjs --swipe 360,900,360,400,400      # 上滑
 *   node tools/explore.mjs --roi 0,1225,720,55              # 只 OCR 底部导航
 *   node tools/explore.mjs --repeat 3 --tap 640,1100        # 重复点 3 次
 *   node tools/explore.mjs --scale 3 --roi 600,250,120,200  # 放大 3 倍再 OCR（读小字）
 */
import fs from 'node:fs';
import path from 'node:path';
import maa from '@maaxyz/maa-node';

import { loadConfig, PATHS } from '../src/config.mjs';
import { createController, screencap } from '../src/controller.mjs';
import { createResource } from '../src/resource.mjs';
import { initRuntime } from '../src/runtime.mjs';
import { createLogger, setLevel, stamp } from '../src/util/log.mjs';
import { imageStats, diffRatio } from '../src/util/png.mjs';
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

function nums(text, expected, label) {
  const parts = String(text).split(',').map((s) => Number(s.trim()));
  if (parts.length !== expected || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--${label} 需要 ${expected} 个数字，收到 "${text}"`);
  }
  return parts;
}

/** "x,y;x,y" -> [[x,y],[x,y]] */
function parseTaps(text) {
  if (!text || text === true) return [];
  return String(text)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => nums(s, 2, 'tap'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wait = Number(args.wait ?? 1500);
  const repeat = Number(args.repeat ?? 1);
  const index = Number(args.instance ?? 0);
  const doOcr = args['no-ocr'] !== true;
  const scale = Math.max(1, Math.min(6, Number(args.scale ?? 1) || 1));
  const roi = args.roi && args.roi !== true ? nums(args.roi, 4, 'roi') : [0, 0, 0, 0];

  const taps = parseTaps(args.tap);
  const swipe = args.swipe && args.swipe !== true ? nums(args.swipe, 5, 'swipe') : null;
  const key = args.key !== undefined && args.key !== true ? Number(args.key) : null;

  setLevel(args.verbose ? 'debug' : 'warn');
  const logger = createLogger('explore');

  const { config, errors } = loadConfig();
  if (errors.length) {
    console.error(`配置错误: ${errors.join('; ')}`);
    process.exit(2);
  }
  // tools 也必须初始化框架日志，否则出问题时框架日志为空、无从排障
  initRuntime(config, logger, { stdoutLevel: args['framework-log'] ? 'All' : 'Warn' });

  const { controller, address } = await createController(config, { index }, logger);

  let tasker = null;
  if (doOcr) {
    const { resource } = await createResource(config, logger);
    tasker = new maa.Tasker();
    tasker.resource = resource;
    tasker.controller = controller;
    if (!tasker.inited) throw new Error('Tasker 初始化失败');
  }

  const planned = [];
  if (taps.length) planned.push(`点击 ${taps.map((t) => `(${t.join(',')})`).join(' → ')}`);
  if (key !== null) planned.push(`按键 ${key}`);
  if (swipe) planned.push(`滑动 (${swipe.slice(0, 4).join(',')}) ${swipe[4]}ms`);

  console.log(`设备: ${address}`);
  if (planned.length) console.log(`动作: ${planned.join(' | ')}（每次后等待 ${wait}ms）`);
  if (repeat > 1) console.log(`重复: ${repeat} 轮`);
  console.log('');

  let prev = null;
  const tag = stamp();

  for (let round = 0; round < repeat; round++) {
    if (repeat > 1) console.log(`########## 第 ${round + 1}/${repeat} 轮 ##########`);

    // ---- 执行动作 ----
    for (const [x, y] of taps) {
      console.log(`> 点击 (${x}, ${y})`);
      await controller.post_click(Math.round(x), Math.round(y)).wait();
      await sleep(wait);
    }
    if (key !== null) {
      console.log(`> 按键 ${key}`);
      await controller.post_click_key(key).wait();
      await sleep(wait);
    }
    if (swipe) {
      const [x1, y1, x2, y2, ms] = swipe;
      console.log(`> 滑动 (${x1},${y1}) → (${x2},${y2}) ${ms}ms`);
      await controller.post_swipe(x1, y1, x2, y2, ms).wait();
      await sleep(wait);
    }

    // ---- 截图 ----
    const shot = await screencap(controller);
    const buf = Buffer.from(shot.data);
    const file = path.join(PATHS.debug, `explore-${tag}-${round + 1}.png`);
    fs.writeFileSync(file, buf);

    console.log(`--- 画面 → ${file} ---`);
    try {
      const s = imageStats(buf);
      console.log(
        `  尺寸 ${s.width}x${s.height}  均值 rgb(${s.mean.join(',')})  ` +
          `对比度 ${s.std}  色数占比 ${s.uniqueRatio}`,
      );
      console.log(`  判定: ${s.verdict}`);
    } catch (e) {
      console.log(`  [像素统计失败] ${e.message}`);
    }
    if (prev) {
      try {
        const d = diffRatio(prev, buf);
        console.log(
          `  与上一张差异: ${(d * 100).toFixed(2)}%` + (d < 0.002 ? '  → 已静止' : '  → 在变化'),
        );
      } catch {
        /* 尺寸不一致时忽略 */
      }
    }
    prev = buf;

    // ---- OCR ----
    if (doOcr) {
      let image = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      // 放大后再识别：地图/图标上的小字（有的框只有 10px 高）在原尺寸下读不出来。
      // 识别框按比例还原回原生坐标，所以打印的中心点仍可直接用于 --tap。
      let recoRoi = roi;
      if (scale > 1) {
        const { width, height } = readImageSize(buf);
        image = maa.Global.resize_image(image, width * scale, height * scale);
        recoRoi = roi[2] > 0 || roi[3] > 0 ? roi.map((v) => v * scale) : roi;
      }
      const reco = await recognizeWithTasker(tasker, 'OCR', { roi: recoRoi, expected: '' }, image);
      const all = allOf(reco);
      if (all.length === 0) {
        console.log('  OCR: (未识别到文字)');
      } else {
        const norm = (box) => box.map((v) => Math.round(v / scale));
        const sorted = [...all].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
        console.log(`  OCR 共 ${all.length} 条${scale > 1 ? `（已放大 ${scale}x）` : ''}：`);
        for (const it of sorted) {
          const box = norm(it.box);
          const cx = Math.round(box[0] + box[2] / 2);
          const cy = Math.round(box[1] + box[3] / 2);
          console.log(
            `    [${box.join(',')}] 中心(${cx},${cy})  ${(it.score ?? 0).toFixed(2)}  ${it.text}`,
          );
        }
      }
    }
    console.log('');
  }

  console.log('提示：上面每条的「中心(x,y)」可直接用于 --tap 继续往下走。');
  process.exit(0);
}

main().catch((e) => {
  console.error(`失败: ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
