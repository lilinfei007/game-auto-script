/**
 * 动态定位 MuMu 模拟器：安装目录 / MuMuManager.exe / adb。
 *
 * 为什么需要它
 * ------------
 * MuMu 的安装位置因机器而异（C 盘还是 D 盘、MuMu 6 还是 MuMu Player 12、
 * 目录名带不带版本号、有没有装在中文路径下）。把路径写死在 `config/config.json`
 * 里有两个问题：换台机器就得手改；而 `config.json` 是**入库文件**，写死了等于
 * 把「某台机器的路径」发给所有人。
 *
 * 检测顺序（先便宜后昂贵，命中即止）
 * ----------------------------------
 *   1. 环境变量 `MUMU_PATH` / `MUMU_HOME` / `MUMU_INSTALL_DIR`（目录）、
 *      `MUMU_MANAGER` / `MUMU_ADB`（具体文件）—— 显式覆盖，优先级最高
 *   2. 注册表：卸载项里的 `InstallLocation` / `UninstallString` / `DisplayIcon`，
 *      以及 `HKCU|HKLM\SOFTWARE\Netease` 下所有像路径的值
 *   3. 常见安装目录：各盘符的盘根、`Program Files[\Netease]`、`Games`、
 *      `%LOCALAPPDATA%`、`%APPDATA%`、`%ProgramData%` 下名字含 mumu 的子目录
 *   4. `where MuMuManager.exe`（装到 PATH 上的少数情况）
 *
 * 全流程**只读**，不写任何文件；任何一步失败都只是「这一步没结果」，不抛异常。
 * 结果按进程缓存（`detectMumu`），因为 `loadConfig` 可能被调用很多次。
 *
 * 找不到时不要报错也不要猜：返回空值，让 `validateConfig` 给一句可操作的提示，
 * 由 `doctor` 去报真正的致命错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** MuMuManager.exe 可能出现的相对位置（新版在前，命中即止）。 */
const MANAGER_LAYOUTS = [
  'nx_main/MuMuManager.exe', // MuMu Player 12
  'MuMuManager.exe',
  'emulator/nemu/vmonitor/bin/MuMuManager.exe', // MuMu 6
  'vmonitor/bin/MuMuManager.exe',
  'nx_main/MuMuManager', // 个别版本不带扩展名
];

/** adb 可能出现的相对位置：MuMu 自己用的那个优先，其次 adb_server。 */
const ADB_LAYOUTS = [
  'nx_main/adb.exe', // MuMu Player 12（MuMuManager 自己调的就是它）
  'nx_device/12.0/shell/adb.exe', // MuMu Player 12 另一处
  'shell/adb.exe',
  'adb.exe',
  'nx_device/12.0/shell/adb_server.exe',
  'emulator/nemu/vmonitor/bin/adb_server.exe', // MuMu 6
  'vmonitor/bin/adb_server.exe',
];

/** 环境变量里可能给出安装目录的名字。 */
const ENV_DIR_KEYS = ['MUMU_PATH', 'MUMU_HOME', 'MUMU_INSTALL_DIR'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 在 dir 下按给定相对路径找第一个存在的文件。 */
function firstExisting(dir, rels) {
  for (const rel of rels) {
    const full = path.join(dir, ...rel.split('/'));
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* 不存在就试下一个 */
    }
  }
  return null;
}

/**
 * 广度优先地在 dir 下找某个文件名（返回最浅的那个）。
 * 只在「已知布局都没命中」时才用，深度受限，避免在 Program Files 这种大目录上乱翻。
 */
function walkFor(startDir, names, maxDepth) {
  const wanted = names.map((n) => n.toLowerCase());
  let level = [startDir];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && wanted.includes(entry.name.toLowerCase())) return full;
        if (entry.isDirectory()) next.push(full);
      }
    }
    level = next;
  }
  return null;
}

/**
 * 判断 dir 是不是一个 MuMu 安装目录，是就返回它的三件套。
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {boolean} [options.walk=true] 已知布局没命中时，是否在目录里浅层搜索
 * @returns {{path: string, manager: string, adb: string}|null}
 */
export function locateMumuIn(dir, { walk = true } = {}) {
  if (!dir || !isDir(dir)) return null;

  let manager = firstExisting(dir, MANAGER_LAYOUTS);
  if (!manager && walk) manager = walkFor(dir, ['MuMuManager.exe'], 3);
  if (!manager) return null;

  let adb = firstExisting(dir, ADB_LAYOUTS);
  if (!adb && walk) adb = walkFor(dir, ['adb.exe', 'adb_server.exe'], 3);

  // path 一律取「被判定为安装根」的这一层：MaaFramework 的 MuMuPlayerExtras
  // 会自己往下拼 nx_main / emulator\nemu\vmonitor\bin，给深了反而找不到
  return { path: dir, manager, adb: adb ?? '' };
}

/**
 * 生成「值得翻一翻」的父目录列表（去重，保持顺序）。
 * 只做路径拼接，不访问磁盘 —— 调用方会逐个 readdir。
 */
export function mumuSearchDirs({ env = process.env, drives = 'CDEFGH', platform = process.platform } = {}) {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };

  for (const key of ENV_DIR_KEYS) if (env[key]) push(env[key]);
  if (platform !== 'win32') return out;

  for (const drive of drives) {
    const root = `${drive}:\\`;
    if (!fs.existsSync(root)) continue;
    push(root);
    for (const sub of [
      'Program Files',
      'Program Files (x86)',
      'Program Files\\Netease',
      'Program Files (x86)\\Netease',
      'Netease',
      'Games',
      'Apps',
      'Software',
    ]) {
      push(path.join(root, sub));
    }
  }

  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA', 'ProgramData']) {
    const base = env[key];
    if (!base) continue;
    push(base);
    push(path.join(base, 'Netease'));
  }
  return out;
}

/** 在父目录下找名字含 mumu 的子目录，逐个当安装根试。 */
function scanChildren(parent) {
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/mumu/i.test(entry.name)) continue;
    const hit = locateMumuIn(path.join(parent, entry.name));
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- 注册表

/** 跑一次 reg query；失败（没有该键、被沙箱挡住）一律当「没结果」。 */
function regQuery(args) {
  try {
    return execFileSync('reg', args, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/** 从一行 reg 输出里取值（形如 `名称    REG_SZ    值`）。 */
function regValueOf(line) {
  const m = /^\s*\S.*?\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.+?)\s*$/.exec(line);
  return m ? m[1] : null;
}

/** 展开 %VAR% 形式的路径。 */
function expandEnv(value) {
  return value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
}

/**
 * 把注册表里的一个字符串值转成「可能装着 MuMu 的目录」候选。
 *
 * 需要兼容的形态：纯目录、`"C:\...\uninst.exe" /S`、`"C:\...\MuMuPlayer.exe",0`、
 * 以及 `nx_main\MuMuManager.exe` 这种指向子目录的可执行文件。
 */
function candidateDirsFromValue(raw) {
  const out = [];
  let v = String(raw ?? '').trim();
  if (!v) return out;

  const quoted = /^"([^"]+)"/.exec(v);
  if (quoted) v = quoted[1];
  else v = v.replace(/,\d+$/, '').split(/\s+\//)[0];

  v = expandEnv(v).replace(/[\\/]+$/, '');
  if (!v) return out;

  const dir = isDir(v) ? v : path.dirname(v);
  if (!isDir(dir)) return out;

  out.push(dir);
  // 指到 nx_main\MuMuManager.exe 时，安装根在上一层
  if (path.basename(dir).toLowerCase() === 'nx_main') out.push(path.dirname(dir));
  return out;
}

/** 从注册表里收集候选目录（卸载项 + Netease 键）。 */
function registryCandidateDirs() {
  const out = [];
  const seen = new Set();
  const push = (d) => {
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  };

  const uninstallKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const key of uninstallKeys) {
    for (const line of regQuery(['query', key, '/s', '/f', 'MuMu']).split(/\r?\n/)) {
      const value = regValueOf(line);
      if (value) for (const d of candidateDirsFromValue(value)) push(d);
    }
  }

  for (const key of [
    'HKLM\\SOFTWARE\\Netease',
    'HKLM\\SOFTWARE\\WOW6432Node\\Netease',
    'HKCU\\SOFTWARE\\Netease',
  ]) {
    for (const line of regQuery(['query', key, '/s']).split(/\r?\n/)) {
      const value = regValueOf(line);
      if (value) for (const d of candidateDirsFromValue(value)) push(d);
    }
  }
  return out;
}

/** `where MuMuManager.exe` 的结果转成候选目录。 */
function pathCandidateDirs() {
  try {
    const out = execFileSync('where', ['MuMuManager.exe'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((p) => candidateDirsFromValue(p));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 检测入口

let cache = null;

/** 清掉进程内缓存（测试与「重新检测」按钮用）。 */
export function resetMumuDetection() {
  cache = null;
  lastDetection = null;
}

/**
 * 定位 MuMu。
 *
 * @param {object} [options]
 * @param {object} [options.env] 环境变量（默认 process.env，测试可注入）
 * @param {string[]} [options.searchDirs] 直接指定要翻的父目录（测试用；给了就不再自己生成）
 * @param {string[]} [options.registryDirs] 直接指定注册表候选（测试用）
 * @param {boolean} [options.useRegistry] 是否查注册表（默认 Windows 上开）
 * @param {boolean} [options.useWhere] 是否用 where 找（默认 Windows 上开）
 * @param {boolean} [options.walk] 已知布局没命中时是否浅层搜索
 * @param {boolean} [options.refresh] 忽略缓存
 * @returns {{path: string, manager: string, adb: string, source: string}|null}
 */
export function detectMumu(options = {}) {
  if (cache && options.refresh !== true) return cache;

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isWin = platform === 'win32';
  const useRegistry = options.useRegistry ?? isWin;
  const useWhere = options.useWhere ?? isWin;
  const walk = options.walk !== false;
  const searchDirs = options.searchDirs ?? mumuSearchDirs({ env, platform });

  let hit = null;
  let source = '';

  // 1) 环境变量：目录型
  for (const key of ENV_DIR_KEYS) {
    if (!env[key]) continue;
    const found = locateMumuIn(env[key], { walk });
    if (found) {
      hit = found;
      source = `环境变量 ${key}`;
      break;
    }
  }

  // 1b) 环境变量：文件型（只给了 exe 的路径）
  if (!hit && env.MUMU_MANAGER) {
    const exeDir = path.dirname(env.MUMU_MANAGER);
    const root = path.basename(exeDir).toLowerCase() === 'nx_main' ? path.dirname(exeDir) : exeDir;
    const found = locateMumuIn(root, { walk });
    if (found) {
      hit = found;
      source = '环境变量 MUMU_MANAGER';
    } else if (fs.existsSync(env.MUMU_MANAGER)) {
      hit = { path: root, manager: env.MUMU_MANAGER, adb: env.MUMU_ADB ?? '' };
      source = '环境变量 MUMU_MANAGER';
    }
  }

  // 2) 注册表
  if (!hit && useRegistry) {
    for (const dir of options.registryDirs ?? registryCandidateDirs()) {
      const found = locateMumuIn(dir, { walk });
      if (found) {
        hit = found;
        source = '注册表（卸载信息 / Netease 键）';
        break;
      }
    }
  }

  // 3) 常见安装目录：父目录本身，或它下面名字含 mumu 的子目录
  if (!hit) {
    for (const dir of searchDirs) {
      const found = locateMumuIn(dir, { walk: false }) ?? scanChildren(dir);
      if (found) {
        hit = found;
        source = `扫描目录 ${dir}`;
        break;
      }
    }
  }

  // 4) PATH 上
  if (!hit && useWhere) {
    for (const dir of pathCandidateDirs()) {
      const found = locateMumuIn(dir, { walk });
      if (found) {
        hit = found;
        source = 'PATH（where MuMuManager.exe）';
        break;
      }
    }
  }

  // MUMU_ADB 可以在任何来源之上补一个 adb
  if (hit && !hit.adb && env.MUMU_ADB) hit = { ...hit, adb: env.MUMU_ADB };

  cache = hit ? { ...hit, source } : null;
  return cache;
}

// ---------------------------------------------------------------- 与配置对接

/** 最近一次 applyMumuDetection 的结果（doctor / 界面展示用）。 */
let lastDetection = null;

export function getMumuDetection() {
  return lastDetection;
}

/**
 * 把自动检测的结果补进 `config.mumu`。
 *
 * 只填**空值**，用户显式写的一律不动 —— 显式配置永远优先于自动检测。
 * 三条路径的推导顺序：
 *   1. 写了 `path`   → 就地按已知布局补 `manager` / `adb`
 *   2. 写了 `manager` → 由它反推安装根，再补 `path` / `adb`
 *   3. 两条都没有     → 全量自动检测
 *
 * 只要用户写了 `path` 或 `manager` 中的任意一条，就**不再去别处找另一套**：
 * 免得把 A 安装的 manager 和 B 安装的 path 拼在一起。
 *
 * 同时记录「哪些字段是自动填的」，保存配置时可以据此把它们剔掉，
 * 免得又写死进 config.json。
 *
 * @returns {{source: string, filled: string[], values: object}|null}
 */
export function applyMumuDetection(config, options = {}) {
  const mumu = (config.mumu ??= {});
  const filled = [];
  let source = null;

  const fill = (key, value, why) => {
    if (mumu[key] || !value) return;
    mumu[key] = value;
    filled.push(key);
    source ??= why;
  };

  if (mumu.path) {
    const hit = locateMumuIn(mumu.path);
    if (hit) {
      fill('manager', hit.manager, `mumu.path 推导（${mumu.path}）`);
      fill('adb', hit.adb, `mumu.path 推导（${mumu.path}）`);
    }
  } else if (mumu.manager) {
    const exeDir = path.dirname(mumu.manager);
    const root = path.basename(exeDir).toLowerCase() === 'nx_main' ? path.dirname(exeDir) : exeDir;
    const hit = locateMumuIn(root);
    if (hit) {
      fill('path', hit.path, 'mumu.manager 推导');
      fill('adb', hit.adb, 'mumu.manager 推导');
    }
  } else {
    const hit = detectMumu(options);
    if (hit) {
      fill('path', hit.path, hit.source);
      fill('manager', hit.manager, hit.source);
      fill('adb', hit.adb, hit.source);
    }
  }

  lastDetection =
    filled.length > 0
      ? { source, filled, values: Object.fromEntries(filled.map((k) => [k, mumu[k]])) }
      : null;
  return lastDetection;
}

/**
 * 保存配置前调用：把「自动检测填进去、用户没改过」的路径删掉。
 *
 * 不这么做的话，界面里点一次保存就会把本机路径固化进入库的 config.json，
 * 自动检测就白做了。用户**改过**的值（与检测结果不同）会原样保留。
 *
 * @returns {object} 可直接落盘的新配置对象（不改原对象）
 */
export function stripDetectedMumuPaths(config) {
  const det = lastDetection;
  if (!det || !config?.mumu) return config;

  const mumu = { ...config.mumu };
  let removed = 0;
  for (const key of det.filled) {
    if (mumu[key] === det.values[key]) {
      delete mumu[key];
      removed++;
    }
  }
  if (removed === 0) return config;
  return { ...config, mumu };
}

/** 实际要调用的 adb：检测到的绝对路径，否则交给 PATH 上的 `adb`。 */
export function adbPath(config) {
  return config?.mumu?.adb || 'adb';
}

/** 一句话描述当前用的是哪套 MuMu 路径（doctor / 界面用）。 */
export function describeMumu(config) {
  const mumu = config?.mumu ?? {};
  if (!mumu.manager) {
    return '未找到 MuMuManager.exe（没装 MuMu？可设环境变量 MUMU_PATH，或在 config/config.json 里显式填 mumu.manager）';
  }
  const det = lastDetection;
  const from = det?.filled?.includes('manager') ? `自动检测：${det.source}` : 'config/config.json';
  const adb = mumu.adb ? mumu.adb : '未找到（将用 PATH 上的 adb）';
  return `${mumu.manager}（${from}）；adb=${adb}`;
}
