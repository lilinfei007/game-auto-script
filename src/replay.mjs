/**
 * 离线录制与回放。
 *
 * 实测 v5.13.1 的格式与坑（这些结论都来自 DLL 字符串与真实录制文件，不是猜的）：
 *
 *  1. `recording_path` 是**文件**，内容是 **JSON Lines**（每行一条记录）。
 *  2. 截图落在**同目录**的 `<文件名去掉扩展名>-Screenshot/` 下，记录里存的是
 *     **相对路径**（如 `mini-Screenshot/screencap_0.png`）。因此归一化产物必须
 *     写在原文件同目录，否则截图找不到。
 *  3. 框架的录制/回放**不对称**：
 *       RecordController 把 pipeline 的 Click   记成 `touch_down` + `touch_up`
 *       RecordController 把 pipeline 的 ClickKey 记成 `key_down`  + `key_up`
 *       而 ReplayController 期望的是 `click` / `click_key`
 *     直接回放必然 `record type mismatch`，而且**指针卡死后不再前进**：
 *     之后每一个请求都报 mismatch 并返回上一次的图，任务会一直空转到超时。
 *     → 所以回放前必须先做归一化（见 normalizeRecords）。
 *  4. 记录类型全集（来自 MaaReplayControlUnit.dll 的 RecordType 枚举）：
 *     connect / click / swipe / multi_swipe / touch_down / touch_move / touch_up /
 *     click_key / input_text / screencap / start_app / stop_app / key_down / key_up /
 *     scroll / relative_move / shell
 *
 * 保真度限制（重要，别把它当万能回归工具）：
 *   回放是**严格顺序**的。流水线里那些「识别不到就反复截图重试」的等待循环，
 *   截图次数取决于真实耗时；回放时截图是瞬时的，次数对不上就会错位。
 *   短小、确定的流水线（无长等待）能完整复现；长等待的流水线可能中途错位。
 *   analyzeRecording 会把这些风险点标出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import maa from '@maaxyz/maa-node';
import { PATHS } from './config.mjs';

/** 需要两两合并的记录类型：down+up 合成框架期望的单条动作。 */
const MERGE_RULES = [
  { down: 'touch_down', up: 'touch_up', into: 'click' },
  { down: 'key_down', up: 'key_up', into: 'click_key' },
];

/** 解析 JSON Lines；坏行会被跳过并计入 badLines。 */
export function readRecording(file) {
  if (!fs.existsSync(file)) throw new Error(`录制文件不存在：${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const records = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { records, badLines };
}

/**
 * 把 down+up 合并成框架回放时期望的单条动作。
 *
 * 只在「两条相邻且没有中间的 touch_move」时才合并 —— 中间有 touch_move 说明
 * 这是一次拖拽/滑动，必须原样保留。
 */
export function normalizeRecords(records) {
  const out = [];
  const merged = { click: 0, click_key: 0 };

  for (let i = 0; i < records.length; i++) {
    const cur = records[i];
    const nxt = records[i + 1];
    const rule = MERGE_RULES.find((r) => r.down === cur.type);

    if (rule && nxt && nxt.type === rule.up) {
      // key_down/key_up 必须同一个键；touch 系列不看 up 的坐标（录制里是 0,0）
      const sameKey = rule.down !== 'key_down' || nxt.keycode === cur.keycode;
      if (sameKey) {
        const rec = { ...cur, type: rule.into, cost: (cur.cost ?? 0) + (nxt.cost ?? 0) };
        // up 记录里的占位坐标不要带进 click
        delete rec.pressure;
        out.push(rec);
        merged[rule.into]++;
        i++;
        continue;
      }
    }
    out.push(cur);
  }
  return { records: out, merged };
}

/** 写出归一化后的录制。返回写入路径。 */
export function writeRecording(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

/** 归一化产物的默认路径：同目录，避免截图相对路径失效。 */
export function normalizedPathOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/\.(rec|jsonl)$/i, '');
  return path.join(dir, `${base}.replay.rec`);
}

/** 截图目录名：`<文件名去掉扩展名>-Screenshot`。 */
export function screenshotDirOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  return path.join(dir, `${base}-Screenshot`);
}

/**
 * 体检一份录制：统计类型、找最长的连续截图段、核对截图文件是否都在。
 *
 * 连续截图段 = 流水线在「等待某个识别结果」重试。这段越长，回放越容易错位。
 */
export function analyzeRecording(records, baseDir) {
  const counts = {};
  for (const r of records) counts[r.type] = (counts[r.type] ?? 0) + 1;

  let longest = 0;
  let run = 0;
  let runStart = -1;
  let longestStart = -1;
  records.forEach((r, i) => {
    if (r.type === 'screencap') {
      if (run === 0) runStart = i;
      run++;
      if (run > longest) {
        longest = run;
        longestStart = runStart;
      }
    } else {
      run = 0;
    }
  });

  const missing = [];
  for (const r of records) {
    if (r.type !== 'screencap' || !r.path) continue;
    const abs = path.isAbsolute(r.path) ? r.path : path.resolve(baseDir, r.path);
    if (!fs.existsSync(abs)) missing.push(r.path);
  }

  const unmerged = records.filter((r) => r.type === 'touch_down' || r.type === 'key_down').length;

  const warnings = [];
  if (missing.length > 0) {
    warnings.push(`有 ${missing.length} 张截图缺失（回放会失败）：${missing.slice(0, 3).join(', ')}`);
  }
  if (longest >= 10) {
    warnings.push(
      `最长连续截图 ${longest} 次（第 ${longestStart} 条起）：说明流水线在这段一直在等待识别结果。` +
        '回放时截图是瞬时的，这段很可能对不上而错位。',
    );
  }
  if (unmerged > 0) {
    warnings.push(`还有 ${unmerged} 条未合并的 touch_down/key_down（拖拽或未配对的按下），回放可能不匹配。`);
  }

  return { counts, total: records.length, longestScreencapRun: longest, longestScreencapStart: longestStart, missingShots: missing, unmergedDowns: unmerged, warnings };
}

/** 一步到位：读原文件 → 归一化 → 写出 → 体检。 */
export function normalizeRecording(src, dst = normalizedPathOf(src)) {
  const { records, badLines } = readRecording(src);
  const before = analyzeRecording(records, path.dirname(src));
  const { records: normalized, merged } = normalizeRecords(records);
  writeRecording(dst, normalized);
  const after = analyzeRecording(normalized, path.dirname(dst));
  return { src, dst, merged, badLines, before, after, records: normalized };
}

/** 默认录制文件路径（debug/recording/<时间戳>.rec）。 */
export function defaultRecordingPath(stampStr) {
  return path.join(PATHS.recording, `${stampStr}.rec`);
}

/** 包一层录制控制器；inner 必须是已连接的控制器。 */
export function createRecordController(inner, file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const controller = new maa.RecordController(inner, file);
  controller.screenshot_target_short_side = config.runtime?.shortSide;
  return controller;
}

/** 回放控制器：不需要模拟器，只读录制文件。 */
export function createReplayController(file, config) {
  if (!fs.existsSync(file)) throw new Error(`录制文件不存在：${file}`);
  const controller = new maa.ReplayController(file);
  controller.screenshot_target_short_side = config.runtime?.shortSide;
  return controller;
}
