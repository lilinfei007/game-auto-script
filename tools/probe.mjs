#!/usr/bin/env node
/**
 * 实时探针：连上模拟器连续截图，报告「画面是否有内容 / 是否在变化 / 上面有什么文字」。
 *
 * 用途（尤其是在看不到图的环境里）：
 *  - 判断游戏是否真的渲染出来了（黑屏？白屏？卡加载？）
 *  - 判断界面是否已经稳定（可用于决定 wait_freezes 参数）
 *  - 直接读出界面文字，据此写 pipeline 的 expected / roi
 *
 * 用法：
 *   node tools/probe.mjs                          # 连续 3 张，间隔 3s
 *   node tools/probe.mjs --count 5 --interval 2000
 *   node tools/probe.mjs --roi 0,1000,720,280     # 只 OCR 该区域
 *   node tools/probe.mjs --no-ocr
 */
import fs from 'node:fs';
import path from 'node:path';
import maa from '@maaxyz/maa-node';

import { loadConfig, PATHS } from '../src/config.mjs';
import { createController, screencap } from '../src/controller.mjs';
import { createResource } from '../src/resource.mjs';
import { createLogger, setLevel, stamp } from '../src/util/log.mjs';
import { imageStats, diffRatio } from '../src/util/png.mjs';
import { initRuntime } from '../src/runtime.mjs';
import { saveImage } from '../src/util/image.mjs';
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
  const p = String(text).split(',').map((s) => Number(s.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    throw new Error(`--roi 需要 4 个数字 x,y,w,h，收到 "${text}"`);
  }
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const count = Number(args.count ?? 3);
  const interval = Number(args.interval ?? 3000);
  const roi = parseRoi(args.roi);
  const doOcr = args['no-ocr'] !== true;
  const index = Number(args.instance ?? 0);

  setLevel(args.verbose ? 'debug' : 'warn');
  const logger = createLogger('probe');

  const { config, errors } = loadConfig();
  if (errors.length) {
    console.error(`配置错误: ${errors.join('; ')}`);
    process.exit(2);
  }
  initRuntime(config, logger, { stdoutLevel: args['framework-log'] ? 'All' : 'Warn' });

  const { controller, address, screencap: sc, input } = await createController(
    config,
    { index },
    logger,
  );
  console.log(`设备: ${address}`);
  console.log(`截图方式: ${sc}`);
  console.log(`输入方式: ${input}`);
  console.log(`连续 ${count} 张，间隔 ${interval}ms${doOcr ? '，含 OCR' : ''}\n`);

  let resource = null;
  let tasker = null;
  if (doOcr) {
    ({ resource } = await createResource(config, logger));
    tasker = new maa.Tasker();
    tasker.resource = resource;
    tasker.controller = controller;
    if (!tasker.inited) throw new Error('Tasker 初始化失败');
  }

  const shots = [];
  for (let i = 0; i < count; i++) {
    const shot = await screencap(controller);
    const buf = Buffer.from(shot.data);
    shots.push(buf);

    const file = path.join(PATHS.debug, `probe-${i + 1}.png`);
    fs.writeFileSync(file, buf);

    let stats = null;
    try {
      stats = imageStats(buf);
    } catch (e) {
      console.log(`  [统计失败] ${e.message}`);
    }

    console.log(`--- 第 ${i + 1}/${count} 张 → ${file} ---`);
    if (stats) {
      console.log(
        `  尺寸 ${stats.width}x${stats.height}  均值 rgb(${stats.mean.join(',')})  ` +
          `对比度 ${stats.std}  色数占比 ${stats.uniqueRatio}`,
      );
      console.log(`  判定: ${stats.verdict}`);
    }
    if (i > 0) {
      try {
        const d = diffRatio(shots[i - 1], buf);
        console.log(
          `  与上一张差异: ${(d * 100).toFixed(2)}%` +
            (d < 0.002 ? '  → 画面已静止' : '  → 画面在变化'),
        );
      } catch (e) {
        console.log(`  [差异计算失败] ${e.message}`);
      }
    }

    if (doOcr) {
      const image = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const reco = await recognizeWithTasker(tasker, 'OCR', { roi, expected: '' }, image);
      if (reco) {
        const all = allOf(reco);
        if (all.length === 0) {
          console.log('  OCR: (未识别到文字)');
        } else {
          const sorted = [...all].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
          console.log(`  OCR 共 ${all.length} 条：`);
          for (const it of sorted) {
            console.log(
              `    [${it.box.join(',')}]  ${(it.score ?? 0).toFixed(2)}  ${it.text}`,
            );
          }
        }
      } else {
        console.log('  OCR: 识别失败');
      }
    }
    console.log('');

    if (i < count - 1) await sleep(interval);
  }

  const tag = stamp();
  console.log(`完成。图片保存在 ${PATHS.debug}\\probe-*.png（本次 ${tag}）`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`失败: ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
