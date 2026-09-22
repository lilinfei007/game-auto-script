#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * 退出码：0 全部成功 / 1 任务失败 / 2 环境或前置条件失败 / 130 用户中断
 */
import fs from 'node:fs';
import path from 'node:path';
import maa from '@maaxyz/maa-node';

import {
  PATHS,
  loadConfig,
  pickInstances,
  resolveInstance,
  ensureDebugDirs,
  applyRuntimeOverrides,
} from './config.mjs';
import { listInstances, ensureInstanceReady } from './device.mjs';
import { createController, screencapToFile, screencap, decodeMethods } from './controller.mjs';
import {
  createResource,
  listPipelineFiles,
  checkOcrModel,
  resolveEntry,
  discoverModules,
  validatePipelines,
} from './resource.mjs';
import { createTasker, runTasks, buildPipelineOverride } from './runner.mjs';
import { createWebRunner } from './runner-web.mjs';
import { initRuntime } from './runtime.mjs';
import { createLogger, setLevel, setLogFile, closeLogFile, stamp } from './util/log.mjs';
import { allOf, recognizeWithTasker } from './util/detail.mjs';
import {
  setLifecycleLogger,
  registerCleanup,
  runCleanups,
  EXIT_INTERRUPTED,
} from './lifecycle.mjs';
import {
  USAGE,
  parseArgs,
  parseInstanceArg,
  decideEntries,
} from './cli-args.mjs';
import { run } from './util/exec.mjs';
import { spawn } from 'node:child_process';
import { startWebServer } from './web.mjs';
import {
  readRecording,
  analyzeRecording,
  normalizeRecording,
  normalizeRecords,
  defaultRecordingPath,
  screenshotDirOf,
  createRecordController,
  createReplayController,
} from './replay.mjs';
import * as events from './events.mjs';

const EXIT = { OK: 0, TASK_FAILED: 1, ENV_FAILED: 2, INTERRUPTED: EXIT_INTERRUPTED };

// ---------------------------------------------------------------- 版本

function appVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PATHS.root, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printVersion() {
  console.log(`game-auto-script ${appVersion()}`);
  console.log(`MaaFramework ${maa.Global?.version ?? '未知'}`);
  console.log(`Node ${process.versions.node} (${process.platform}-${process.arch})`);
}

// ---------------------------------------------------------------- doctor

async function cmdDoctor(config, warnings, logger, args = {}) {
  const checks = [];
  const record = (name, ok, detail, fatal = false) => {
    checks.push({ name, ok, detail, fatal });
    const mark = ok ? '✔' : fatal ? '✘' : '⚠';
    const line = `${mark} ${name}${detail ? ` — ${detail}` : ''}`;
    if (ok) logger.info(line);
    else if (fatal) logger.error(line);
    else logger.warn(line);
    return ok;
  };

  logger.info('=== 环境自检 ===');

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  record('Node 版本', major >= 20, `v${process.versions.node}（需要 >= 20）`, true);

  // 2. maa-node 版本
  const version = maa.Global?.version ?? '未知';
  record('MaaFramework 版本', version === 'v5.13.1', version, false);

  // 3. 配置
  record('配置文件', fs.existsSync(PATHS.configFile), PATHS.configFile, false);
  for (const w of warnings) logger.warn(`  配置提示：${w}`);

  // 4. OCR 模型
  const ocr = checkOcrModel();
  record(
    'OCR 模型',
    ocr.ok,
    ocr.ok ? ocr.dir : `缺少 ${ocr.missing.join(', ')}（运行 npm run fetch-assets）`,
    false,
  );

  // 5. 流水线文件能否解析
  const pipes = validatePipelines();
  const badPipes = pipes.filter((p) => !p.ok);
  record(
    '流水线解析',
    pipes.length > 0 && badPipes.length === 0,
    badPipes.length === 0
      ? `${pipes.length} 个文件全部可解析`
      : badPipes.map((p) => `${p.file}: ${p.error}`).join('; '),
    false,
  );

  // 6. 可执行模块（自动发现的顺序）
  const modules = discoverModules();
  const usable = modules.filter((m) => m.ok);
  record(
    '可执行模块',
    usable.length > 0,
    usable.length > 0
      ? usable.map((m) => `${m.base}→${m.entry}`).join(', ')
      : '(无：pipeline 目录下没有可执行的模块文件)',
    false,
  );

  // 7. MuMu 实例
  const all = await listInstances(config, logger);
  const target = config.instances[0]?.index ?? 0;
  const inst = all.find((i) => i.index === target);
  record(
    'MuMu 实例',
    all.length > 0,
    all.length === 0
      ? '读取不到任何实例'
      : `共 ${all.length} 个；目标 ${target}：${inst ? (inst.isAndroidStarted ? '运行中' : '已停止') : '不存在'}`,
    true,
  );

  if (checks.some((c) => !c.ok && c.fatal)) {
    logger.error('致命检查未通过，终止自检');
    return EXIT.ENV_FAILED;
  }

  // 8. 拉起实例 + adb
  let ready;
  try {
    ready = await ensureInstanceReady(config, target, logger);
    record('实例就绪', true, ready.address);
  } catch (e) {
    record('实例就绪', false, e.message, true);
    return EXIT.ENV_FAILED;
  }

  // 9. 控制器 + 截图
  let controller;
  try {
    const created = await createController(config, { index: target }, logger);
    controller = created.controller;
    record(
      '控制器',
      true,
      `截图=${decodeMethods(created.screencap, maa.AdbScreencapMethod).join('|')} 输入=${decodeMethods(created.input, maa.AdbInputMethod).join('|')}`,
    );

    const shotFile = path.join(PATHS.debug, 'doctor.png');
    const shot = await screencapToFile(controller, shotFile);
    const sizeText = shot.size ? `${shot.size.width}x${shot.size.height}` : '无法解析尺寸';
    const expectShort = config.runtime.shortSide;
    record(
      '截图',
      !!shot.size,
      `${sizeText}（短边 ${shot.shortSide}，期望 ${expectShort}）→ ${shotFile}`,
    );
    if (shot.size && shot.shortSide !== expectShort) {
      logger.warn(
        `  短边 ${shot.shortSide} ≠ 期望 ${expectShort}：模板裁剪必须与此一致，否则匹配会失败`,
      );
    }
  } catch (e) {
    record('控制器/截图', false, e.message, true);
    return EXIT.ENV_FAILED;
  }

  // 10. 游戏包名
  const pkg = config.game.package;
  const res = await run(config.mumu.adb, ['-s', ready.address, 'shell', 'pm', 'list', 'packages'], {
    timeoutMs: 20000,
  });
  const packages = (res.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^package:/, '').trim())
    .filter(Boolean);
  const installed = packages.includes(pkg);
  record(
    '游戏包名',
    installed,
    installed
      ? `${pkg} 已安装`
      : `配置为 ${pkg}，但在设备上未找到` +
          (packages.length ? `（设备共 ${packages.length} 个包）` : '（读取不到包列表）'),
    false,
  );

  if (!installed) {
    const guess = packages.filter((p) => /gof|winter|survival|wjdr|snow|century|diandian/i.test(p));
    if (guess.length) logger.warn(`  可能的候选包名：${guess.join(', ')}`);
    logger.warn('  提示：用 `adb shell pm list packages | findstr <关键词>` 查出后填入 config/config.json');
  }

  // 11. 资源加载（只加载一次，--deep 复用）
  let resource = null;
  try {
    const created = await createResource(config, logger);
    resource = created.resource;
    record('资源加载', created.nodes.length > 0, `${created.nodes.length} 个节点`, false);
  } catch (e) {
    record('资源加载', false, e.message, true);
  }

  // 12. --deep：实跑一个节点，验证整条链路
  if (args.deep) {
    if (!resource) {
      record('深检（实跑节点）', false, '资源未加载，跳过', true);
    } else {
      try {
        const tasker = createTasker(controller, resource, logger);
        const nodes = resource.node_list ?? [];
        const probe = nodes.includes('等待画面稳定') ? '等待画面稳定' : nodes[0];
        const { ok } = await runTasks(
          tasker,
          controller,
          [probe],
          config,
          logger,
          buildPipelineOverride(config),
        );
        record('深检（实跑节点）', ok, `节点 ${probe}`, true);
      } catch (e) {
        record('深检（实跑节点）', false, e.message, true);
      }
    }
  }

  const fatalFailures = checks.filter((c) => !c.ok && c.fatal);
  const softFailures = checks.filter((c) => !c.ok && !c.fatal);
  logger.info('=== 自检结果 ===');
  logger.info(
    `通过 ${checks.filter((c) => c.ok).length}/${checks.length}，警告 ${softFailures.length}，致命 ${fatalFailures.length}`,
  );
  if (softFailures.length > 0) {
    for (const c of softFailures) logger.warn(`  待处理：${c.name} — ${c.detail ?? ''}`);
  }

  return fatalFailures.length === 0 ? EXIT.OK : EXIT.ENV_FAILED;
}

// ---------------------------------------------------------------- list

function cmdList(config) {
  const logger = createLogger('list');
  logger.info('=== 实例 ===');
  for (const inst of config.instances) {
    const { address } = resolveInstance(config, inst.index);
    const tasks = (inst.tasks ?? []).filter(Boolean);
    logger.info(
      `  [${inst.index}] ${inst.enabled === false ? '已禁用' : '启用'} ${address} 任务=${tasks.length ? tasks.join(', ') : '(自动发现)'}`,
    );
  }

  logger.info('=== 流水线文件（文件名 → 入口节点）===');
  const files = listPipelineFiles();
  if (files.length === 0) logger.info('  (无)');
  for (const p of validatePipelines()) {
    if (p.ok) {
      const shared = p.base.startsWith('_') ? '  [共享]' : '';
      logger.info(`  ${p.base} → ${p.entry ?? '(空文件)'}（${p.nodes.length} 个节点）${shared}`);
    } else {
      logger.error(`  ${p.file} ✘ 解析失败：${p.error}`);
    }
  }

  logger.info('=== 自动发现的执行顺序（run 不带 --tasks 时）===');
  const modules = discoverModules();
  if (modules.length === 0) logger.info('  (无)');
  modules.forEach((m, i) => {
    logger.info(`  ${i + 1}. ${m.ok ? `✔ ${m.entry}  ← ${m.base}` : `✘ ${m.base}：${m.error}`}`);
  });

  logger.info('=== 游戏 ===');
  logger.info(`  包名: ${config.game.package}`);
  logger.info(`  短边: ${config.runtime.shortSide}`);
  logger.info(`  失败截图: 框架=${config.runtime.saveOnError !== false ? '开' : '关'} 本项目=${config.runtime.saveFailureShot === true ? '开' : '关'}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- capture

async function cmdCapture(config, args, logger) {
  const index = parseInstanceArg(args) ?? config.instances[0]?.index ?? 0;
  const { controller } = await createController(config, { index }, logger);
  const tag = args.tag && args.tag !== true ? String(args.tag) : stamp();
  const dir =
    args.out && args.out !== true
      ? path.resolve(String(args.out))
      : path.join(PATHS.rawImage, tag);
  fs.mkdirSync(dir, { recursive: true });

  const count = Math.max(1, Number(args.count ?? 1) || 1);
  const intervalMs = Math.max(0, Number(args.interval ?? 1500) || 0);

  let tasker = null;
  if (args.ocr) {
    const { resource } = await createResource(config, logger);
    tasker = createTasker(controller, resource, logger);
  }

  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}.png`);
    const shot = await screencapToFile(controller, file);
    logger.info(
      `  截图 ${i + 1}/${count} → ${file}` +
        (shot.size ? ` (${shot.size.width}x${shot.size.height})` : ''),
    );

    if (tasker) {
      const reco = await recognizeWithTasker(tasker, 'OCR', { roi: [0, 0, 0, 0], expected: '' }, shot.data);
      const all = allOf(reco);
      if (all.length === 0) logger.info('      (未识别到文字)');
      for (const it of all) {
        const [x, y, w, h] = it.box;
        logger.info(
          `      [${x},${y},${w},${h}] 中心(${Math.round(x + w / 2)},${Math.round(y + h / 2)}) ${it.text}`,
        );
      }
    }

    if (i < count - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }

  logger.info(`完成，共 ${count} 张 → ${dir}`);
  logger.info('提示：用图片工具裁剪出模板，放到 resource/image/；纯文字控件优先用 OCR，不必裁模板');
  return EXIT.OK;
}

// ---------------------------------------------------------------- run

async function cmdRun(config, args, logger) {
  const index = parseInstanceArg(args) ?? config.instances[0]?.index ?? 0;
  const inst = pickInstances(config, index)[0];

  // 资源加载不需要设备，所以 --dry-run 也能跑
  const { resource, nodes } = await createResource(config, logger);

  const { entries, source } = decideEntries(config, inst, args, nodes, logger);
  if (entries.length === 0) {
    logger.error('没有要执行的任务：pipeline 目录下没有可执行的模块，也没有配置 instances[].tasks');
    return EXIT.ENV_FAILED;
  }

  const resolved = entries.map((e) => resolveEntry(e, nodes, logger));
  logger.info(`任务来源：${source}`);
  logger.info(`将执行 ${resolved.length} 个：${resolved.join(', ')}`);

  if (args['dry-run']) {
    logger.info('--dry-run：只校验入口与资源，不连接设备');
    let allKnown = true;
    for (const r of resolved) {
      const known = nodes.includes(r);
      if (!known) allKnown = false;
      logger.info(`  ${known ? '✔' : '✘'} ${r}${known ? '' : '（资源里没有这个节点）'}`);
    }
    logger.info(allKnown ? '校验通过' : '校验失败：存在无法解析的入口');
    return allKnown ? EXIT.OK : EXIT.ENV_FAILED;
  }

  const retry = Math.max(0, Number(args.retry ?? 0) || 0);
  const { controller } = await createController(config, inst, logger);
  const tasker = createTasker(controller, resource, logger);
  const override = buildPipelineOverride(config);
  logger.debug(`pipeline_override: ${JSON.stringify(override)}`);

  const { ok, results } = await runTasks(tasker, controller, resolved, config, logger, override, {
    retry,
  });

  logger.info('=== 执行汇总 ===');
  for (const r of results) {
    logger.info(`  ${r.ok ? '✔' : '✘'} ${r.entry}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  logger.info(`${results.length - failed} 成功 / ${failed} 失败`);

  return ok ? EXIT.OK : EXIT.TASK_FAILED;
}

// ---------------------------------------------------------------- record

/** record 与 replay 共用：决定跑哪些入口。 */
async function resolveEntriesFor(config, inst, args, logger) {
  const { resource, nodes } = await createResource(config, logger);
  const { entries, source } = decideEntries(config, inst, args, nodes, logger);
  if (entries.length === 0) {
    logger.error('没有要执行的任务：pipeline 目录下没有可执行的模块，也没有配置 instances[].tasks');
    return null;
  }
  const resolved = entries.map((e) => resolveEntry(e, nodes, logger));
  logger.info(`任务来源：${source}`);
  logger.info(`将执行 ${resolved.length} 个：${resolved.join(', ')}`);
  return { resource, nodes, resolved };
}

async function cmdRecord(config, args, logger) {
  const index = parseInstanceArg(args) ?? config.instances[0]?.index ?? 0;
  const inst = pickInstances(config, index)[0];

  const prepared = await resolveEntriesFor(config, inst, args, logger);
  if (!prepared) return EXIT.ENV_FAILED;

  const file =
    typeof args.out === 'string' && args.out
      ? path.resolve(args.out)
      : defaultRecordingPath(stamp());

  const { controller: inner } = await createController(config, inst, logger);
  const recorder = createRecordController(inner, file, config);
  logger.info(`录制到：${file}`);

  if (!(await recorder.post_connection().wait().succeeded)) {
    logger.error('录制控制器连接失败');
    return EXIT.ENV_FAILED;
  }

  const tasker = createTasker(recorder, prepared.resource, logger);
  const { ok, results } = await runTasks(
    tasker,
    recorder,
    prepared.resolved,
    config,
    logger,
    buildPipelineOverride(config),
    { retry: Math.max(0, Number(args.retry ?? 0) || 0) },
  );

  logger.info('=== 录制汇总 ===');
  for (const r of results) {
    logger.info(`  ${r.ok ? '✔' : '✘'} ${r.entry}${r.reason ? ` — ${r.reason}` : ''}`);
  }

  if (!fs.existsSync(file)) {
    logger.error('没有生成录制文件：确认任务确实产生了控制器调用');
    return EXIT.TASK_FAILED;
  }

  const { records: raw } = readRecording(file);
  // 体检要做在**归一化后**的记录上：原始文件里的 down/up 成对是正常的，
  // 回放用的才是合并后的形态，告警应当描述那个形态。
  const { records: normalized, merged } = normalizeRecords(raw);
  const report = analyzeRecording(normalized, path.dirname(file));
  logger.info(
    `录制文件：${file}（${fs.statSync(file).size} 字节，原始 ${raw.length} 条 → 回放用 ${report.total} 条）`,
  );
  if (merged.click || merged.click_key) {
    logger.info(
      `  合并：touch_down+touch_up → click ×${merged.click}，key_down+key_up → click_key ×${merged.click_key}`,
    );
  }
  logger.info(`  记录类型：${Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  logger.info(`  截图目录：${screenshotDirOf(file)}`);
  for (const w of report.warnings) logger.warn(`  ⚠ ${w}`);

  logger.info('');
  logger.info('回放请用：node src/index.mjs replay --record "' + file + '"');
  logger.info('注意：回放是严格顺序的，流水线里长等待（反复截图重试）的段落可能错位');

  return ok ? EXIT.OK : EXIT.TASK_FAILED;
}

// ---------------------------------------------------------------- replay

async function cmdReplay(config, args, logger) {
  const raw = typeof args.record === 'string' && args.record ? args.record : null;
  if (!raw) {
    logger.error('replay 需要 --record <文件>（用 record 命令生成，或直接给 debug/recording 下的文件）');
    return EXIT.ENV_FAILED;
  }
  const file = path.resolve(raw);
  if (!fs.existsSync(file)) {
    logger.error(`录制文件不存在：${file}`);
    return EXIT.ENV_FAILED;
  }

  // 归一化：框架把 Click/ClickKey 记成 down+up，回放却期望 click/click_key
  const norm = normalizeRecording(file);
  logger.info(`原始录制：${file}（${norm.before.total} 条）`);
  logger.info(`归一化后：${norm.dst}（${norm.after.total} 条）`);
  if (norm.merged.click || norm.merged.click_key) {
    logger.info(
      `  合并：touch_down+touch_up → click ×${norm.merged.click}，key_down+key_up → click_key ×${norm.merged.click_key}`,
    );
  }
  if (norm.badLines > 0) logger.warn(`  跳过了 ${norm.badLines} 行无法解析的记录`);
  for (const w of norm.after.warnings) logger.warn(`  ⚠ ${w}`);

  // 回放不需要模拟器：这里刻意不调用 ensureInstanceReady
  const inst = pickInstances(config, parseInstanceArg(args) ?? config.instances[0]?.index ?? 0)[0];
  const prepared = await resolveEntriesFor(config, inst, args, logger);
  if (!prepared) return EXIT.ENV_FAILED;

  logger.info('离线回放（不连接模拟器）');
  const replayer = createReplayController(norm.dst, config);
  if (!(await replayer.post_connection().wait().succeeded)) {
    logger.error('回放控制器连接失败：录制文件可能损坏');
    return EXIT.ENV_FAILED;
  }

  const tasker = createTasker(replayer, prepared.resource, logger);
  const { ok, results } = await runTasks(
    tasker,
    replayer,
    prepared.resolved,
    config,
    logger,
    buildPipelineOverride(config),
    { retry: 0 },
  );

  logger.info('=== 回放汇总 ===');
  for (const r of results) {
    logger.info(`  ${r.ok ? '✔' : '✘'} ${r.entry}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  if (!ok) {
    logger.warn('回放失败不一定是流水线坏了：回放是严格顺序的，');
    logger.warn('长等待段落（连续截图重试）在回放时次数对不上就会错位。看上面的 ⚠ 提示。');
  }
  return ok ? EXIT.OK : EXIT.TASK_FAILED;
}

// ---------------------------------------------------------------- ui

/**
 * 把真实依赖注入执行层。
 *
 * 这里只做「接线」：所有决策逻辑都在 runner-web.mjs 里，因此可以用假实现单测。
 * `getConfig` 传的是可变闭包 —— 界面改配置（PUT /api/config）后立刻生效，无需重启。
 */
function buildUiRunner(getConfig, defaultIndex, logger) {
  return createWebRunner({
    getConfig,
    logger,
    defaultInstance: defaultIndex,

    instanceFactory: (index) => ensureInstanceReady(getConfig(), index, logger),

    controllerFactory: async (cfg, inst) => createController(cfg, inst, logger),

    resourceFactory: (cfg) => createResource(cfg, logger),

    taskerFactory: (controller, resource) => createTasker(controller, resource, logger),

    runTasks: (tasker, controller, entries, cfg, lg, override, opts) =>
      runTasks(tasker, controller, entries, cfg, lg, override, opts),

    pipelineOverride: (cfg) => buildPipelineOverride(cfg),

    screencap: (controller) => screencap(controller).then((r) => r.data),

    tapImpl: async (controller, x, y) => {
      await controller.post_click(x, y).wait();
      return true;
    },

    swipeImpl: async (controller, from, to, durationMs) => {
      await controller.post_swipe(from[0], from[1], to[0], to[1], durationMs).wait();
      return true;
    },

    /**
     * 单节点试跑：用一个临时 tasker 跑一个节点，用于「界面上点一下就想试这个节点」。
     * 结果通过事件层登记，界面能直接看到成败与最后节点。
     */
    runNodeImpl: async (index, node, timeoutMs) => {
      const cfg = getConfig();
      const inst = pickInstances(cfg, index)[0];
      const { controller } = await createController(cfg, inst, logger);
      const { resource } = await createResource(cfg, logger);
      const tasker = createTasker(controller, resource, logger);
      const { ok, results } = await runTasks(
        tasker,
        controller,
        [node],
        { ...cfg, runtime: { ...cfg.runtime, taskTimeoutMs: timeoutMs } },
        logger,
        buildPipelineOverride(cfg),
        {},
      );
      return { ok, results, entry: node };
    },
  });
}

async function cmdUi(config, args, logger) {
  const port = Number(args.port ?? 8848);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port 需要 1-65535 的整数，收到 ${args.port}`);
  }
  const host = args['allow-remote'] === true ? '0.0.0.0' : '127.0.0.1';
  const defaultIndex = parseInstanceArg(args) ?? config.instances[0]?.index ?? 0;

  // 可变配置：界面改配置后立刻生效（详见 buildUiRunner 的注释）
  let currentConfig = config;
  const getConfig = () => currentConfig;
  const setConfig = (next) => {
    currentConfig = next;
  };

  logger.info(
    `界面可用参数：${Object.keys(args).filter((k) => k !== '_').join(', ') || '（默认）'}`,
  );

  const runner = buildUiRunner(getConfig, defaultIndex, logger);
  runner.installCleanup();

  const server = await startWebServer({
    config,
    logger,
    runner,
    port,
    host,
    appVersion: appVersion(),
  });
  registerCleanup(() => server.close(), '关闭网页服务');

  if (args.open) {
    // stdio:'ignore' 是必须的：沙箱下管道 stdio 会 EPERM（见 util/exec.mjs 的注释）
    const [cmd, cmdArgs] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', server.url]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [server.url]];
    try {
      spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
      logger.info('已尝试打开浏览器');
    } catch (e) {
      logger.warn(`自动打开浏览器失败：${e.message}（请手动访问 ${server.url}）`);
    }
  }

  logger.info('按 Ctrl+C 停止服务');

  // 保持进程存活，直到收到信号（收尾逻辑会关闭服务并退出）
  await new Promise(() => {});
  return EXIT.OK;
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`参数错误：${e.message}`);
    console.error('');
    console.error(USAGE);
    process.exit(EXIT.ENV_FAILED);
  }

  // help / version 必须在读配置之前处理：配置坏了也要能看帮助
  if (args.help === true || args._[0] === 'help') {
    console.log(USAGE);
    process.exit(EXIT.OK);
  }
  if (args.version === true || args._[0] === 'version') {
    printVersion();
    process.exit(EXIT.OK);
  }

  const command = args._[0] ?? 'doctor';

  // doctor 是「环境体检」，路径不存在在这里必须是致命错误；
  // 其它命令只要用不到模拟器就不该被它挡住（例如 list / run --dry-run / ui）。
  const { config, exists, errors, warnings } = loadConfig({
    strictPaths: command === 'doctor',
  });

  // 先用安全的等级把日志建起来：config.runtime.logLevel 本身可能就是错的，
  // 早先直接 setLevel(配置值) 会抛未捕获异常，反而看不到「配置错误」的提示。
  setLevel(args.verbose ? 'debug' : 'info');
  ensureDebugDirs();
  const logFile = setLogFile(path.join(PATHS.debug, `run-${stamp()}.log`));
  const logger = createLogger('main');
  setLifecycleLogger(logger);

  // 正常结束与 Ctrl+C 都要收尾，否则日志最后几行会丢
  registerCleanup(() => closeLogFile(), '关闭日志');

  logger.debug(`工作目录 ${PATHS.root}`);
  logger.debug(`日志文件 ${logFile}`);

  if (errors.length) {
    for (const e of errors) logger.error(`配置错误：${e}`);
    if (!exists) {
      logger.error(`未找到 ${PATHS.configFile}。可参考 src/config.mjs 的 DEFAULT_CONFIG 创建`);
    }
    logger.error('请先修正配置，再用 `npm run doctor` 复查');
    await runCleanups();
    process.exit(EXIT.ENV_FAILED);
  }

  // 配置已确认合法，这时才套用配置里的日志等级
  if (!args.verbose) setLevel(config.runtime.logLevel);

  initRuntime(config, logger);

  let code = EXIT.OK;
  try {
    switch (command) {
      case 'doctor':
        code = await cmdDoctor(config, warnings, logger, args);
        break;
      case 'list':
        code = cmdList(config);
        break;
      case 'capture':
        code = await cmdCapture(config, args, logger);
        break;
      case 'run':
        code = await cmdRun(config, args, logger);
        break;
      case 'ui':
        code = await cmdUi(config, args, logger);
        break;
      case 'record':
        code = await cmdRecord(config, args, logger);
        break;
      case 'replay':
        code = await cmdReplay(config, args, logger);
        break;
      default:
        logger.error(`未知命令：${command}`);
        console.error('');
        console.error(USAGE);
        code = EXIT.ENV_FAILED;
    }
  } catch (e) {
    logger.error(`执行失败：${e.message}`);
    logger.debug(e.stack ?? '');
    code = EXIT.ENV_FAILED;
  }

  await runCleanups();
  process.exit(code);
}

main();
