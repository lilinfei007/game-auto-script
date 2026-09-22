/**
 * 进程生命周期：统一收尾 + 信号处理。
 *
 * 为什么需要：原先 `closeLogFile()` 只在 main() 正常返回时调用。
 * 用户按 Ctrl+C 时日志流不会 flush（最后几行丢失），tasker 也不会 post_stop，
 * 结果是「日志断在半路 + 游戏停在某个界面」。
 *
 * 用法：
 *   setLifecycleLogger(logger);
 *   registerCleanup(() => tasker.post_stop().wait(), '停止任务');
 *   // 正常结束时也要主动调用 runCleanups()
 */
import { createLogger } from './util/log.mjs';

/** 退出码：128 + SIGINT(2)。 */
export const EXIT_INTERRUPTED = 130;

const cleanups = [];
let installed = false;
let exiting = false;
let log = createLogger('lifecycle');

export function setLifecycleLogger(logger) {
  log = logger;
}

/**
 * 注册一个收尾函数（后注册的先执行）。
 * @returns {() => void} 注销函数
 */
export function registerCleanup(fn, label = 'cleanup') {
  const entry = { fn, label };
  cleanups.push(entry);
  install();
  return () => {
    const i = cleanups.indexOf(entry);
    if (i >= 0) cleanups.splice(i, 1);
  };
}

/** 依次执行全部收尾；单个失败不影响其它。 */
export async function runCleanups() {
  while (cleanups.length > 0) {
    const { fn, label } = cleanups.pop();
    try {
      await fn();
    } catch (e) {
      log.debug(`收尾「${label}」失败：${e.message}`);
    }
  }
}

export function hasCleanups() {
  return cleanups.length > 0;
}

function install() {
  if (installed) return;
  installed = true;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (exiting) {
        // 收尾卡住时再按一次能强制退出，否则用户只能去杀进程
        log.warn('再次收到中断，强制退出');
        process.exit(EXIT_INTERRUPTED);
      }
      exiting = true;
      log.warn(`收到 ${sig}，正在停止并收尾…（再按一次可强制退出）`);
      await runCleanups();
      process.exit(EXIT_INTERRUPTED);
    });
  }
}

/**
 * 供测试重置。
 * 刻意**不**移除进程上的信号监听：`installed` 保持为 true，
 * 否则每次重置后再注册都会叠加一组 SIGINT/SIGTERM 处理器。
 */
export function resetForTest() {
  cleanups.length = 0;
  exiting = false;
}
