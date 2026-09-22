/**
 * 运行期初始化：把配置映射到 MaaFramework 的全局选项。
 *
 * 单独抽出来的原因：CLI 与 tools/ 下的诊断脚本都必须走同一套设置。
 * 早先 tools 没设 `log_dir`，导致框架日志为空 —— 排障时「什么都看不到」，
 * 定位 OCR 问题因此多绕了很多弯路。现在统一从这里初始化。
 */
import maa from '@maaxyz/maa-node';
import { PATHS, ensureDebugDirs } from './config.mjs';

/**
 * @param {object} config 已加载并校验的配置
 * @param {object} [logger]
 * @param {object} [options]
 * @param {string} [options.stdoutLevel] 覆盖框架输出级别（tools 调试时可设 'All'）
 * @param {string} [options.logDir]
 * @param {boolean} [options.saveDraw]
 */
export function initRuntime(config, logger, options = {}) {
  ensureDebugDirs();

  const runtime = config.runtime ?? {};
  const stdoutLevel =
    options.stdoutLevel ?? (runtime.logLevel === 'silent' ? 'Off' : 'Warn');
  const logDir = options.logDir ?? PATHS.debug;
  const saveDraw = options.saveDraw ?? runtime.saveDraws === true;

  maa.Global.log_dir = logDir;
  maa.Global.stdout_level = stdoutLevel;
  maa.Global.save_draw = saveDraw;
  maa.Global.save_on_error = runtime.saveOnError !== false;

  logger?.debug(
    `MaaFramework 全局选项：log_dir=${logDir} stdout_level=${stdoutLevel} ` +
      `save_draw=${saveDraw} save_on_error=${runtime.saveOnError !== false}`,
  );

  return { logDir, stdoutLevel, saveDraw };
}
