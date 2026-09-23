/**
 * MuMu 实例生命周期管理。
 *
 * 背景：上一版实现（MAA-WJDR）在任务中途因模拟器被关闭而崩溃 —— 日志显示
 * `adb connect 127.0.0.1:16384` 反复返回 10061（目标计算机积极拒绝），最终
 * `controller screencap failed`。根因是**没有任何实例存活前置检查**。
 * 本模块用官方 MuMuManager CLI 在动手前把实例拉到「Android 已启动 + adb 已连」。
 *
 * MuMuManager 用法（已实测，v12 NX）：
 *   MuMuManager.exe info --vmindex all          # 输出**以实例号为键的对象**
 *   MuMuManager.exe info -v <i>                 # 输出单个实例对象
 *   MuMuManager.exe control -v <i> launch       # 启动实例
 *   MuMuManager.exe adb -v <i> -c connect       # 为该实例建立 adb 连接
 *
 * ⚠️ 两个踩过的坑：
 *   1. `info --vmindex all` 的返回是 `{"0": {...}, "1": {...}}`（键是字符串索引），
 *      **不是数组**。早先只处理「数组」与「本身就是实例的对象」，
 *      于是真实输出被解析成 3 个没有 index 字段的对象、全部被丢掉，
 *      `doctor` 直接报「读取不到任何实例」。
 *   2. 字段名有下划线版（`is_android_started`）与驼峰版（`isAndroidStarted`）两种，
 *      不同 MuMu 版本/子命令不一致，两种都要认。
 */
import { run, extractJsonValues } from './util/exec.mjs';
import { adbPath as resolveAdbPath } from './mumu-detect.mjs';

/** 取第一个「不是 undefined/null」的值。 */
function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** 宽松布尔：兼容 true / "true" / 1 / "1"。 */
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return false;
}

/**
 * 把一个原始 item 规范化成实例对象；没有可用索引时返回 null。
 *
 * @param {object} item MuMuManager 返回的单个实例
 * @param {string} [key] 该 item 在「以索引为键的对象」里的键
 */
export function normalizeInstance(item, key) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  // 索引来源优先级：item.index（字符串或数字）> 键名 > adb_port 反推
  const rawIndex = pick(item.index, item.vmindex, item.vm_index, key);
  let index = rawIndex !== undefined && rawIndex !== '' ? Number(rawIndex) : NaN;
  if (!Number.isInteger(index) || index < 0) return null;

  const rawPort = pick(item.adb_port, item.adbPort);
  const adbPort = rawPort !== undefined && rawPort !== '' ? Number(rawPort) : undefined;

  return {
    index,
    name: pick(item.name, item.vm_name, item.vmName) ?? `实例 ${index}`,
    isMain: toBool(pick(item.is_main, item.isMain)),
    isAndroidStarted: toBool(pick(item.is_android_started, item.isAndroidStarted)),
    isProcessStarted: toBool(pick(item.is_process_started, item.isProcessStarted)),
    adbPort: Number.isFinite(adbPort) ? adbPort : undefined,
    hypervEnabled: toBool(pick(item.hyperv_enabled, item.hypervEnabled)),
    raw: item,
  };
}

/**
 * 把 `extractJsonValues` 抽出的任意一段 JSON 摊平成实例数组。
 * 覆盖三种真实形态：
 *   - `[{...}, {...}]`              数组
 *   - `{"0": {...}, "1": {...}}`    以索引为键的对象（`--vmindex all` 的形态）
 *   - `{index: 0, ...}`             单个实例对象
 */
export function flattenInstances(value) {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value.map((item) => normalizeInstance(item)).filter(Boolean);
  }
  if (typeof value !== 'object') return [];

  const direct = normalizeInstance(value);
  if (direct) return [direct];

  // 以索引为键的对象：值都是对象，键是索引
  const out = [];
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeInstance(item, key);
    if (normalized) out.push(normalized);
  }
  return out;
}

/** 按索引去重（同一实例可能被多段输出重复描述），保留字段更全的那条。 */
function dedupe(instances) {
  const byIndex = new Map();
  for (const inst of instances) {
    const prev = byIndex.get(inst.index);
    if (!prev) {
      byIndex.set(inst.index, inst);
      continue;
    }
    byIndex.set(inst.index, {
      ...prev,
      ...inst,
      // adbPort 只在有值时才覆盖，避免后一条的空值把前面的好值抹掉
      adbPort: inst.adbPort ?? prev.adbPort,
      name: inst.name || prev.name,
    });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** 读取全部实例信息，返回规范化并按索引排序的数组。 */
export async function listInstances(config, logger) {
  const { manager } = config.mumu;
  const res = await run(manager, ['info', '--vmindex', 'all'], { timeoutMs: 20000 });

  const text = `${res.stdout}\n${res.stderr}`;
  const instances = dedupe(extractJsonValues(text).flatMap(flattenInstances));

  if (instances.length === 0) {
    logger?.warn(`未能从 MuMuManager 解析出实例信息；stdout=${text.slice(0, 300)}`);
  }
  return instances;
}

export async function getInstance(config, index, logger) {
  const all = await listInstances(config, logger);
  return all.find((i) => i.index === index) ?? null;
}

/** 启动实例（幂等：已在运行时 launch 也无害）。 */
export async function launchInstance(config, index, logger) {
  logger?.info(`启动 MuMu 实例 ${index} ...`);
  const res = await run(config.mumu.manager, ['control', '-v', String(index), 'launch'], {
    timeoutMs: 60000,
  });
  if (!res.ok) {
    logger?.warn(`launch 返回非零：code=${res.code} ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res;
}

/** 等待 Android 起来（轮询 MuMuManager 的实例状态）。 */
export async function waitForAndroid(config, index, logger, timeoutMs) {
  const limit = timeoutMs ?? config.runtime?.launchTimeoutMs ?? 90000;
  const deadline = Date.now() + limit;
  logger?.info(`等待实例 ${index} 的 Android 启动（上限 ${Math.round(limit / 1000)}s）...`);

  while (Date.now() < deadline) {
    const inst = await getInstance(config, index, logger);
    if (inst?.isAndroidStarted) {
      logger?.info(`实例 ${index} Android 已启动`);
      return inst;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`实例 ${index} 在 ${Math.round(limit / 1000)}s 内仍未启动 Android`);
}

/**
 * 让 adb 连上实例。
 *
 * 注意：MuMu 自己会注册一个 `emulator-5554`（可能处于 offline），
 * 本项目的控制器明确用 `127.0.0.1:<port>`，因此这里以 IP 形式连接为准。
 */
export async function adbConnect(config, index, logger) {
  const res = await run(config.mumu.manager, ['adb', '-v', String(index), '-c', 'connect'], {
    timeoutMs: 30000,
  });
  logger?.debug(`MuMuManager adb connect: ${(res.stdout || res.stderr || '').trim().slice(0, 200)}`);
  return res;
}

/** 用 adb 直接验证设备可响应（比 adb devices 列表更可靠）。 */
export async function adbAlive(config, address, logger) {
  const res = await run(resolveAdbPath(config), ['-s', address, 'shell', 'echo', 'ok'], {
    timeoutMs: 15000,
  });
  const ok = res.ok && res.stdout.includes('ok');
  if (!ok) {
    logger?.debug(`adbAlive(${address}) 失败：${(res.stderr || res.stdout).trim().slice(0, 200)}`);
  }
  return ok;
}

/**
 * 前置检查：把实例拉到「Android 已启动 + adb 可响应」，返回权威的 adb 地址。
 * 任一步失败都抛出带明确原因的异常（不再静默重试）。
 */
export async function ensureInstanceReady(config, index, logger) {
  let inst = await getInstance(config, index, logger);

  if (!inst) {
    throw new Error(
      `MuMu 中不存在实例 ${index}。请检查 mumu.manager 路径，或运行 ` +
        `\`${config.mumu.manager} info --vmindex all\` 查看现有实例。`,
    );
  }

  if (!inst.isAndroidStarted) {
    await launchInstance(config, index, logger);
    inst = await waitForAndroid(config, index, logger);
  }

  // MuMu 报告的端口优先；否则按约定推算
  const fallbackPort = config.mumu.basePort + config.mumu.portStep * index;
  const port = inst.adbPort ?? fallbackPort;
  const address = `127.0.0.1:${port}`;

  if (!(await adbAlive(config, address, logger))) {
    logger?.info(`adb 未就绪，尝试 connect ${address} ...`);
    await adbConnect(config, index, logger);

    const deadline = Date.now() + 20000;
    let alive = false;
    while (Date.now() < deadline) {
      if (await adbAlive(config, address, logger)) {
        alive = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!alive) {
      throw new Error(
        `实例 ${index} 的 adb 地址 ${address} 无法连接。可能原因：实例正在关机/重启、` +
          'MuMu 的 adb 端口与预期不一致，或游戏内 adb 调试被关闭。',
      );
    }
  }

  return { instance: inst, address, port };
}
