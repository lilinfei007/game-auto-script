/**
 * ADB 控制器创建与截图。
 *
 * 两个刻意的设计点（相对上一版 MAA-WJDR 的实测缺陷）：
 *  1. 显式把 EmulatorExtras 并进 input 掩码。MaaFramework 的默认值
 *     (AdbInputMethod.Default = 18446744073709551607 = ~8) **不含** EmulatorExtras，
 *     会退化成 Maatouch —— 每次连接都要 push maatouch 并 app_process 起一个 Java 进程。
 *     MuMu 12 支持 EmulatorExtras，直接用它更快更稳。
 *  2. 统一 screenshot_target_short_side，使截图与模板裁剪基准一致（默认 720）。
 */
import maa from '@maaxyz/maa-node';
import { resolveInstance } from './config.mjs';
import { ensureInstanceReady } from './device.mjs';
import { adbPath as resolveAdbPath } from './mumu-detect.mjs';
import { saveImage, readImageSize, shortSide } from './util/image.mjs';

/** 位或若干掩码（maa-node 的 Uint64 以字符串暴露，故用 BigInt）。 */
export function orMethods(...values) {
  let acc = 0n;
  for (const v of values) {
    if (v === undefined || v === null) continue;
    acc |= BigInt(v);
  }
  return acc.toString();
}

/** 把掩码还原成人类可读的方法名列表。 */
export function decodeMethods(mask, table) {
  const m = BigInt(mask);
  return Object.entries(table)
    .filter(([k, v]) => !['All', 'Default'].includes(k) && (m & BigInt(v)) !== 0n)
    .map(([k]) => k);
}

/**
 * 扫描设备并挑选目标实例。
 * 优先用 MaaToolkit 自动识别出的设备（它会带上正确的 MuMu extras 配置）。
 */
export async function findDevice(config, address, logger) {
  let devices = [];
  try {
    devices = (await maa.AdbController.find(resolveAdbPath(config))) ?? [];
  } catch (e) {
    logger?.warn(`AdbController.find 失败：${e.message}（将使用配置中的默认值）`);
  }
  logger?.debug(`发现 ${devices.length} 个 ADB 设备：${devices.map((d) => d[2]).join(', ') || '(无)'}`);

  const match = devices.find((d) => d[2] === address);
  if (match) logger.info(`命中设备：${match[0]} @ ${match[2]}`);
  else logger?.warn(`设备列表中没有 ${address}，将按配置直接构造控制器`);

  return match ?? null;
}

/**
 * 构造 Adb 控制器的 extras 配置。
 *
 * 必须带上 `path`（MuMu 安装目录）：MaaFramework 的 MuMuPlayerExtras 靠它去加载
 * MuMu 的原生库，缺失时会报 `Failed to load library [lib_path_=]` 并静默退化成
 * 普通 adb 截图/输入。设备扫描结果里的 extras 不一定含 path，所以这里强制补上。
 */
export function buildExtrasConfig(deviceConfigJson, index, mumuPath) {
  let cfg = {};
  if (deviceConfigJson) {
    try {
      cfg = JSON.parse(deviceConfigJson);
    } catch {
      cfg = {};
    }
  }
  // 注意：JSON 里 "[]" / "null" 都是合法解析结果，但数组会把后加的属性在
  // stringify 时丢掉，所以数组也必须回退成对象。
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};

  cfg.extras = cfg.extras ?? {};
  cfg.extras.mumu = {
    ...(cfg.extras.mumu ?? {}),
    enable: true,
    index,
    path: mumuPath,
  };
  return JSON.stringify(cfg);
}

/**
 * 创建并连接控制器。
 * @returns {Promise<{controller: object, address: string, screencap: string, input: string}>}
 */
export async function createController(config, instanceConfig, logger) {
  const index = instanceConfig.index;
  const ready = await ensureInstanceReady(config, index, logger);
  const match = await findDevice(config, ready.address, logger);

  const adbPath = match?.[1] ?? resolveAdbPath(config);
  const screencap = orMethods(
    match?.[3] ?? maa.AdbScreencapMethod.Default,
    maa.AdbScreencapMethod.EmulatorExtras,
  );
  const input = orMethods(
    match?.[4] ?? maa.AdbInputMethod.Default,
    maa.AdbInputMethod.EmulatorExtras,
  );
  const extras = buildExtrasConfig(match?.[5], index, config.mumu.path);

  logger.debug(`screencap=${screencap} (${decodeMethods(screencap, maa.AdbScreencapMethod).join('|')})`);
  logger.debug(`input=${input} (${decodeMethods(input, maa.AdbInputMethod).join('|')})`);
  logger.debug(`extras=${extras}`);

  const controller = new maa.AdbController(
    adbPath,
    ready.address,
    screencap,
    input,
    extras,
    maa.AdbController.agent_path(),
  );

  controller.screenshot_target_short_side = config.runtime.shortSide;
  controller.add_sink((_ctrl, msg) => logger.debug(`[ctrl] ${msg.msg} ${msg.action ?? ''}`));

  const job = controller.post_connection().wait();
  if (!(await job.succeeded)) {
    throw new Error(
      `控制器连接失败：${ready.address}。请确认 MuMu 实例 ${index} 正在运行且 adb 可用。`,
    );
  }
  logger.info(`控制器已连接：${ready.address}`);

  return { controller, address: ready.address, screencap, input, deviceName: match?.[0] };
}

/**
 * 截图一次并返回 `{data, size}`。
 *
 * ⚠️ maa 的 `job.get()` 返回的是 **ArrayBuffer**，不是 Node 的 Buffer
 * （实测 `byteLength=1285101`、`Buffer.isBuffer()===false`、`.length` 为 undefined）。
 * 只看 `.length` 会把「拿到图了」误判成「空数据」，所以这里统一归一成 Buffer，
 * 让所有调用方（落盘、HTTP 响应、尺寸解析）都能按 Node 惯例用 `.length`。
 *
 * @returns {Promise<{data: Buffer, size: {format:string,width:number,height:number}|null}>}
 */
export async function screencap(controller) {
  const job = controller.post_screencap().wait();
  const raw = await job.get();
  if (!raw) throw new Error('截图失败：返回空数据');
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (data.length === 0) throw new Error('截图失败：数据长度为 0');
  return { data, size: readImageSize(data) };
}

/** 截图并落盘，返回尺寸信息（用于 doctor / capture / 失败留证）。 */
export async function screencapToFile(controller, filePath) {
  const { data, size } = await screencap(controller);
  const saved = saveImage(data, filePath);
  // data 一并返回：capture --ocr 需要拿同一张图去识别，避免重复截图
  return { ...saved, data, size, shortSide: shortSide(size) };
}
