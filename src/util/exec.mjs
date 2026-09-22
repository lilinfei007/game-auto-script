/**
 * child_process 封装：统一超时、编码、大缓冲与错误收敛。
 *
 * 调用外部程序（MuMuManager / adb / tar）一律走这里，便于集中处理失败。
 *
 * 双模式说明
 * ----------
 * 默认用管道（stdio: 'pipe'）捕获子进程输出，这是最常见也最高效的方式。
 * 但受限环境（沙箱 / 部分 CI）禁止进程打开命名管道，Node 在 Windows 上正是用
 * 命名管道实现 pipe，会直接抛 `EPERM spawn EPERM`。
 * 因此本模块在遇到该错误时**自动降级**为「文件描述符」模式：把子进程的
 * stdout/stderr 重定向到临时文件，退出后再读回。两者对外行为一致。
 *
 * 可调用 getExecMode() 查看当前处于哪种模式（doctor 会展示）。
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pExecFile = promisify(execFile);

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30000;

/** 'pipe' | 'file' —— 探测到管道被禁后固定为 'file'。 */
let execMode = 'pipe';
let fallbackReason = null;

export function getExecMode() {
  return { mode: execMode, fallbackReason };
}

function isPermissionError(error) {
  const code = error?.code;
  const msg = String(error?.message ?? '');
  return code === 'EPERM' || /EPERM|operation not permitted/i.test(msg);
}

function tempDir() {
  const base = fs.existsSync(os.tmpdir()) ? os.tmpdir() : process.cwd();
  return fs.mkdtempSync(path.join(base, 'wjdr-exec-'));
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

async function runPiped(file, args, { timeoutMs, cwd, maxBuffer }) {
  try {
    const { stdout, stderr } = await pExecFile(file, args, {
      timeout: timeoutMs,
      cwd,
      maxBuffer,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    // 超时 / 非零退出：execFile 会把已有输出带在 error 上
    const timedOut = error?.killed === true || error?.signal != null;
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : -1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
      error,
      timedOut,
    };
  }
}

/** 用文件描述符代替管道捕获输出。 */
function runFileStdio(file, args, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    let dir;
    try {
      dir = tempDir();
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: e });
      return;
    }

    const outPath = path.join(dir, 'out');
    const errPath = path.join(dir, 'err');
    let outFd = null;
    let errFd = null;
    let child = null;

    const cleanup = () => {
      for (const fd of [outFd, errFd]) {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            /* 已关闭 */
          }
        }
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    };

    try {
      outFd = fs.openSync(outPath, 'w');
      errFd = fs.openSync(errPath, 'w');
      child = spawn(file, args, {
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        cwd,
      });
    } catch (e) {
      cleanup();
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: e });
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }, timeoutMs);

    const settle = (code, spawnError) => {
      clearTimeout(timer);
      const stdout = readIfExists(outPath);
      const stderr = readIfExists(errPath);
      cleanup();
      resolve({
        ok: code === 0 && !spawnError && !timedOut,
        code: typeof code === 'number' ? code : -1,
        stdout,
        stderr: stderr || (spawnError ? String(spawnError.message ?? spawnError) : ''),
        error: spawnError,
        timedOut,
      });
    };

    child.on('error', (e) => settle(-1, e));
    child.on('close', (code) => settle(code, null));
  });
}

/**
 * 运行外部命令，永不抛异常（失败以 ok:false 返回）。
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string, error?:Error, timedOut?:boolean}>}
 */
export async function run(file, args = [], options = {}) {
  const opts = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    cwd: options.cwd,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };

  if (execMode === 'file') return runFileStdio(file, args, opts);

  const result = await runPiped(file, args, opts);

  if (!result.ok && isPermissionError(result.error)) {
    // 管道被环境禁止 —— 永久切换到文件模式并重试一次
    execMode = 'file';
    fallbackReason = `管道捕获被拒绝（${result.error?.code ?? 'EPERM'}），已切换到文件描述符模式`;
    return runFileStdio(file, args, opts);
  }

  return result;
}

/** 从任意文本中抽取顶层平衡的 JSON 对象/数组（MuMuManager 可能输出多段）。 */
export function extractJsonValues(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        const chunk = text.slice(start, i + 1);
        try {
          out.push(JSON.parse(chunk));
        } catch {
          /* 忽略无法解析的片段 */
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}
