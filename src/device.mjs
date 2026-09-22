/**
 * MuMu 实例生命周期管理。
 *
 * 背景：上一版实现（MAA-WJDR）在任务中途因模拟器被关闭而崩溃 —— 日志显示
 * `adb connect 127.0.0.1:16384` 反复返回 10061（目标计算机积极拒绝），最终
 * `controller screencap failed`。根因是**没有任何实例存活前置检查**。
 * 本模块用官方 MuMuManager CLI 在动手前把实例拉到「Android 已启动 + adb 已连」。
 *
 * MuMuManager 用法（已实测）：
 *   MuMuManager.exe info --vmindex all          # 输出实例 JSON（index 为字符串）
 *   MuMuManager.exe control -v <i> launch       # 启动实例
 *   MuMuManager.exe adb -v <i> -c connect       # 为该实例建立 adb 连接
 */
import { run, extractJsonValues } from './util/exec.mjs';

/** 读取全部实例信息，返回规范化后的数组。 */
export async function listInstances(config, logger) {
  const { manager } = config.mumu;
  const res = await run(manager, ['info', '--vmindex', 'all'], { timeoutMs: 20000 });

  const text = `${res.stdout}\n${res.stderr}`;
  const values = extractJsonValues(text);

  const instances = [];
  for (const v of values) {
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      if (!item || typeof item !== 'object' || item.index === undefined) continue;
      instances.push({
        index: Number(item.index),
        name: item.name,
        isMain: item.is_main === true,
        isAndroidStarted: item.is_android_started === true,
        isProcessStarted: item.is_process_started === true,
        adbPort: item.adb_port !== undefined ? Number(item.adb_port) : undefined,
        hypervEnabled: item.hyperv_enabled === true,
        raw: item,
      });
    }
  }

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
  return res.ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 Android 启动完成。 */
export async function waitForAndroid(config, index, logger, timeoutMs) {
  const limit = timeoutMs ?? config.runtime.launchTimeoutMs;
  const deadline = Date.now() + limit;
  let last = null;

  while (Date.now() < deadline) {
    const inst = await getInstance(config, index, null);
    last = inst;
    if (inst?.isAndroidStarted) {
      logger?.info(`实例 ${index} Android 已启动（adb_port=${inst.adbPort ?? '未知'}）`);
      return inst;
    }
    await sleep(2000);
  }

  throw new Error(
    `实例 ${index} 在 ${Math.round(limit / 1000)}s 内未完成启动` +
      (last ? `（is_process_started=${last.isProcessStarted}, is_android_started=${last.isAndroidStarted}）` : '（读取不到实例信息）'),
  );
}

/** 为指定实例建立 adb 连接。 */
export async function adbConnect(config, index, logger) {
  const res = await run(config.mumu.manager, ['adb', '-v', String(index), '-c', 'connect'], {
    timeoutMs: 30000,
  });
  const text = `${res.stdout}${res.stderr}`.trim();
  if (/cannot connect|failed|拒绝/i.test(text)) {
    logger?.warn(`adb connect 输出异常：${text}`);
    return false;
  }
  return true;
}

/** 用 adb 直接验证设备可响应（比 adb devices 列表更可靠）。 */
export async function adbAlive(config, address, logger) {
  const res = await run(config.mumu.adb, ['-s', address, 'shell', 'echo', 'ok'], {
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
      await sleep(1500);
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
