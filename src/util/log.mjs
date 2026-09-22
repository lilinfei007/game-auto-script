/**
 * 极简分级日志：控制台彩色输出 + 可选文件落盘。
 * 无第三方依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { publishLog } from '../events.mjs';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 100 };
const COLORS = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

let minLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
// 用 fd + writeSync 而不是 WriteStream：WriteStream.end() 是异步的，
// 紧跟着的 process.exit() 会把还没落盘的最后几行截掉
// （实测日志文件比控制台少最后 3 行）。同步写量很小，代价可忽略。
let fileFd = null;
let filePath = null;

export function setLevel(name) {
  if (!(name in LEVELS)) throw new Error(`未知日志等级: ${name}`);
  minLevel = LEVELS[name];
}

export function getLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === minLevel) ?? 'info';
}

/** 开启文件落盘；自动创建父目录。返回实际使用的文件路径。 */
export function setLogFile(target) {
  closeLogFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fileFd = fs.openSync(target, 'a');
  filePath = target;
  return target;
}

export function getLogFile() {
  return filePath;
}

export function closeLogFile() {
  if (fileFd !== null) {
    try {
      fs.closeSync(fileFd);
    } catch {
      /* 已关闭则忽略 */
    }
    fileFd = null;
    filePath = null;
  }
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function emit(level, scope, args) {
  if (LEVELS[level] < minLevel) return;
  const ts = timestamp();
  const text = args.map(formatArg).join(' ');
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] [${scope}] ${text}`;

  if (fileFd !== null) fs.writeSync(fileFd, line + '\n');

  // 推给事件总线（Web UI 的 SSE 订阅），保留最近若干条供新连接补发
  publishLog({ ts, level, scope, message: text });

  const color = COLORS[level] ?? '';
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  process.stdout.write(
    useColor ? `${color}${line}${RESET}\n` : `${line}\n`,
  );
}

/** 创建一个带作用域名的 logger。 */
export function createLogger(scope) {
  const make = (level) => (...args) => emit(level, scope, args);
  return {
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  };
}

/** 生成 debug/ 下的时间戳文件名，例如 20260511-154037。 */
export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export { LEVELS };
