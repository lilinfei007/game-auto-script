/**
 * 文件写入辅助：原子写 + 备份 + 纯函数式的 JSON 读写。
 *
 * 为什么单开一个模块：从界面改配置会同时用到 `config/`、`resource/pipeline/` 与
 * `config/tasks.json`，三处都需要「先校验、再原子落盘、顺手备份」这一套。
 * 原子写的意义：写一半断电/被杀进程时不会留下半个坏 JSON 把程序卡死。
 */
import fs from 'node:fs';
import path from 'node:path';

import { PATHS } from '../config.mjs';

/** 备份保留份数（按文件名时间戳排序，旧的删掉）。 */
const BACKUP_KEEP = 10;

/** 时间戳：`20260922-165413-492`，可安全用于文件名。 */
export function fileStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-` +
    `${p(date.getMilliseconds(), 3)}`
  );
}

/**
 * 原子写文本：先写同目录下的临时文件，再 `rename` 覆盖目标。
 * 同一分区内 rename 是原子的，因此目标文件要么是旧内容、要么是新内容。
 */
export function writeFileAtomic(filePath, text, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // 临时文件必须和目标同目录，否则跨分区 rename 会退化成复制（不再原子）
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, text, encoding);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return filePath;
}

/** 原子写 JSON（2 空格缩进 + 末尾换行，和手工编辑的文件保持一致）。 */
export function writeJsonAtomic(filePath, obj) {
  return writeFileAtomic(filePath, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * 备份一个文件到目标目录，文件名带时间戳。
 * 源文件不存在时返回 null（调用方不必先判断）。
 *
 * @returns {string|null} 备份文件的绝对路径
 */
export function backupFile(src, backupDir = PATHS.configBackups, keep = BACKUP_KEEP) {
  if (!fs.existsSync(src)) return null;
  fs.mkdirSync(backupDir, { recursive: true });

  const base = path.basename(src).replace(/\.jsonc?$/i, '');
  const dest = path.join(backupDir, `${base}-${fileStamp()}.json`);
  fs.copyFileSync(src, dest);

  // 只保留最近 keep 份：备份是防手滑，不是归档
  const prefix = `${base}-`;
  const olds = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - keep))) {
    fs.rmSync(path.join(backupDir, f), { force: true });
  }
  return dest;
}

/** 读取 JSON 文件；不存在返回 `{exists:false}`，解析失败抛出带文件名的错误。 */
export function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, text: null, json: null, mtime: null };
  const text = fs.readFileSync(filePath, 'utf8');
  const mtime = fs.statSync(filePath).mtimeMs;
  try {
    return { exists: true, text, json: JSON.parse(text), mtime };
  } catch (e) {
    throw new Error(`${path.basename(filePath)} 解析失败：${e.message}`);
  }
}
