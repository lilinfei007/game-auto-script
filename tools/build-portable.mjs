/**
 * 打包成可分发目录（可选打 zip）。
 *
 *   node tools/build-portable.mjs                     默认：dist/game-auto-script-<版本>/
 *   node tools/build-portable.mjs --with-node          连 node.exe 一起带上（对方不用装 Node）
 *   node tools/build-portable.mjs --zip                再打一个 zip
 *   node tools/build-portable.mjs --slim               去掉 test/ 与开发用工具
 *   node tools/build-portable.mjs --out D:/somewhere   指定输出目录
 *
 * 必须带上**两个**包：@maaxyz/maa-node 只是平台分发壳，真正的原生绑定
 * （MaaNode.node / MaaFramework.dll / MaaReplayControlUnit.dll）在
 * @maaxyz/maa-node-win32-x64 里。只拷前者会得到一个跑不起来的包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { zipDirectory } from '../src/util/zip.mjs';
import { run } from '../src/util/exec.mjs';
import { buildWebui, WEBUI_DIST, WEBUI_ENTRY } from './webui-build.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const valueOf = (f, dflt) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const withNode = has('with-node');
const wantZip = has('zip');
const slim = has('slim');
const noTests = has('no-tests') || slim;

const pkg = JSON.parse(fs.readFileSync(path.join(PATHS.root, 'package.json'), 'utf8'));
const outDir = path.resolve(valueOf('out', path.join(PATHS.root, 'dist', `${pkg.name}-${pkg.version}`)));

const MB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------- 拷贝

/**
 * 需要排除的相对路径（正斜杠）。
 *
 * 只按**根级**目录判断。早先写成「任意层级出现 dist 就排除」，
 * 结果把 node_modules/@maaxyz/maa-node/dist 一起排掉了 —— 打出来的包
 * 一启动就 ERR_MODULE_NOT_FOUND。这个坑由 build 末尾的实际运行校验兜住。
 */
function isExcluded(rel) {
  const parts = rel.split('/');
  const top = parts[0];

  if (['debug', 'dist', '.git', '.npm-cache'].includes(top)) return true;
  if (top === 'node_modules' && parts[1] === '.cache') return true;
  if (top === '.gitignore' || top === '.npmrc') return true;

  if (rel === 'resource/image/_raw' || rel.startsWith('resource/image/_raw/')) return true;
  if (rel.startsWith('docs/reference/')) return true;
  if (rel.endsWith('.log')) return true;

  if (noTests && top === 'test') return true;
  if (slim && top === 'tools' && rel !== 'tools/selftest-replay.mjs') return true;
  return false;
}

function copyTree(srcRoot, dstRoot) {
  let files = 0;
  let bytes = 0;

  const walk = (rel) => {
    const src = path.join(srcRoot, rel);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isExcluded(childRel)) continue;
      const from = path.join(srcRoot, childRel);
      const to = path.join(dstRoot, childRel);
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(childRel);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        files++;
        bytes += fs.statSync(from).size;
      }
    }
  };
  walk('');
  return { files, bytes };
}

// ---------------------------------------------------------------- 启动器

const LAUNCH_HELPER = `@echo off
rem 内部使用：定位 node.exe 并调用入口脚本。所有启动器都经过这里。
rem 入口脚本由调用方通过 WJDR_SCRIPT 指定，默认 src\\index.mjs。
setlocal
cd /d "%~dp0"
if not defined WJDR_SCRIPT set "WJDR_SCRIPT=src\\index.mjs"
set "NODE_EXE="
if exist "%~dp0node\\node.exe" set "NODE_EXE=%~dp0node\\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  echo.
  echo   [错误] 找不到 Node.js
  echo.
  echo   这个包需要 Node.js 20 或更高版本。
  echo   请到 https://nodejs.org/ 下载安装 LTS 版，然后重新双击本文件。
  echo   或者改用带 node 的完整包（打包时加 --with-node）。
  echo.
  pause
  exit /b 2
)
"%NODE_EXE%" "%~dp0%WJDR_SCRIPT%" %*
exit /b %ERRORLEVEL%
`;

/**
 * 生成一个启动器。
 * chcp 切到 UTF-8：否则 Node 输出的中文在默认 GBK 控制台里是乱码。
 * @param {string} pre 在调用前要执行的 batch 行（\n 分隔）
 */
function launcher(title, args, { pre = '', autoClose = true } = {}) {
  const preLines = pre ? pre.split('\n').join('\n') + '\n' : '';
  return `@echo off
chcp 65001 >nul
title ${title}
cd /d "%~dp0"
${preLines}call "%~dp0_node.cmd" ${args} %*
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="0" exit /b 0
if "%CODE%"=="130" exit /b 130
echo.
echo   退出码 %CODE%
${autoClose ? 'pause' : 'rem'}
exit /b %CODE%
`;
}

const README_TXT = `《无尽冬日》日常自动化 —— 使用说明
================================================

一、先确认模拟器
  1. 打开 MuMu 模拟器，启动《无尽冬日》，进到游戏主界面。
  2. 建议把模拟器分辨率设成 720x1280（脚本按短边 720 适配，会自动缩放）。

二、五个启动器
  环境自检.cmd      先跑这个。它会检查 Node、MaaFramework、MuMu、OCR 模型、
                    游戏包名等，最后给出一份通过/失败清单。
  执行日常.cmd      按文件名顺序执行 resource/pipeline 下的所有模块。
  启动界面.cmd      打开本地网页界面（浏览器里点按钮执行、看实时日志）。
  录制回放自检.cmd  验证录制/回放功能（会真的操作一下游戏，需要模拟器开着）。
  离线回放自检.cmd  只回放上一次的录制，不需要模拟器。

三、改配置
  用记事本打开 config\\config.json。最常改的是：
    mumu.path / mumu.manager / mumu.adb    MuMu 的安装路径
    game.package                           《无尽冬日》的包名
    runtime.shortSide                      截图短边，默认 720
    instances[].tasks                      留空 [] = 自动跑所有模块
  改完再跑一次「环境自检.cmd」。

四、出了问题看哪里
  debug\\run-*.log        每次运行的完整日志
  debug\\on_error\\        失败瞬间的截图（文件名带节点名）
  debug\\draws\\           识别可视化（框出它到底看到了什么）

五、重要提醒
  《无尽冬日》对脚本/同步器的封禁比较激进。请只挂自己的号、
  降低频率、不要 24 小时挂着。建议先拿小号试。

六、卸载
  整个目录删掉即可，不会往系统里写任何东西。
`;

function writeLaunchers(dir) {
  const w = (name, text) => fs.writeFileSync(path.join(dir, name), text.replace(/\n/g, '\r\n'), 'utf8');
  w('_node.cmd', LAUNCH_HELPER);
  w('环境自检.cmd', launcher('环境自检', 'doctor'));
  w('执行日常.cmd', launcher('执行日常', 'run'));
  w('启动界面.cmd', launcher('启动界面', 'ui --open'));
  w(
    '录制回放自检.cmd',
    launcher('录制回放自检', '', { pre: 'set "WJDR_SCRIPT=tools\\selftest-replay.mjs"' }),
  );
  w(
    '离线回放自检.cmd',
    launcher('离线回放自检', '--replay-only', {
      pre: 'set "WJDR_SCRIPT=tools\\selftest-replay.mjs"',
    }),
  );
  w('使用说明.txt', README_TXT);
}

// ---------------------------------------------------------------- 主流程

console.log(`打包 ${pkg.name} v${pkg.version}`);
console.log(`  输出目录：${outDir}`);
console.log(`  选项：${withNode ? '带 node.exe ' : ''}${wantZip ? '打 zip ' : ''}${slim ? '精简 ' : ''}${noTests ? '不含 test/ ' : ''}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 先把控制台构建出来再拷：启动器是直接 `node src\index.mjs ui`，不走 npm 的 preui，
// 所以包里有什么 dist 就发什么。dist 在 src/ 下面，不会被 isExcluded 的根级规则排掉。
await buildWebui({ quiet: true });

const copied = copyTree(PATHS.root, outDir);
writeLaunchers(outDir);

// 单独处理 node.exe：不在项目目录里，copyTree 覆盖不到
if (withNode) {
  const nodeDir = path.join(outDir, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(nodeDir, 'node.exe'));
  console.log(`  已带上 node.exe（${MB(fs.statSync(process.execPath).size)}）`);
}

// ---------------------------------------------------------------- 校验

const mustExist = [
  'src/index.mjs',
  'config/config.json',
  'resource/pipeline/_common.json',
  'resource/model/ocr',
  'node_modules/@maaxyz/maa-node/package.json',
  // 真正的原生绑定在这里，缺了包就是废的
  'node_modules/@maaxyz/maa-node-win32-x64/MaaNode.node',
  'node_modules/@maaxyz/maa-node-win32-x64/MaaFramework.dll',
  '_node.cmd',
  '环境自检.cmd',
];
let missing = 0;
for (const rel of mustExist) {
  if (!fs.existsSync(path.join(outDir, rel))) {
    console.error(`  ✘ 缺少 ${rel}`);
    missing++;
  }
}

const totalBytes = (function size(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return n;
})(outDir);

console.log('');
console.log(`  文件 ${copied.files} 个，目录体积 ${MB(totalBytes)}`);
if (missing > 0) {
  console.error(`打包失败：缺少 ${missing} 个必要文件`);
  process.exit(1);
}
console.log('  ✔ 必要文件齐全（含原生绑定与 DLL）');

/**
 * 控制台是可选件：没构建出来时界面会退回内联页，包仍然可用，所以不判失败。
 * 但「dist 拷进来了、它引用的资源却丢了」必须当失败 —— 那种包打开就是白屏，
 * 比没有控制台更难查。
 */
let lostConsoleAssets = 0;
const packedEntry = path.join(outDir, path.relative(PATHS.root, WEBUI_ENTRY));
if (fs.existsSync(packedEntry)) {
  const refs = [...fs.readFileSync(packedEntry, 'utf8').matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  const lost = refs.filter((r) => !fs.existsSync(path.join(outDir, path.relative(PATHS.root, WEBUI_DIST), r)));
  if (lost.length) {
    console.error(`  ✘ 控制台缺少它引用的资源：${lost.join('、')}`);
    lostConsoleAssets = lost.length;
  } else {
    console.log(`  ✔ 控制台齐全（${refs.length} 个资源）`);
  }
} else {
  console.warn('  ! 这个包里没有 Vue 控制台，界面会退回内联页（先 npm install 再打包即可）');
}
if (lostConsoleAssets > 0) {
  console.error(`打包失败：控制台缺少 ${lostConsoleAssets} 个资源`);
  process.exit(1);
}

// ---------------------------------------------------------------- 实跑校验
// 「文件都在」不等于「跑得起来」：曾经因为排除规则误伤 node_modules/.../dist，
// 必要文件清单照样通过，但一 import 就 ERR_MODULE_NOT_FOUND。
// 所以这里真的用包里的代码跑一遍，并且刻意换一个 cwd（验证不依赖工作目录）。

const NODE = withNode ? path.join(outDir, 'node', 'node.exe') : process.execPath;
const entry = path.join(outDir, 'src', 'index.mjs');
const probeCwd = path.dirname(outDir);

async function probe(label, args) {
  const r = await run(NODE, [entry, ...args], { cwd: probeCwd, timeoutMs: 120000 });
  const ok = r.ok && !/ERR_MODULE_NOT_FOUND|Cannot find module/.test(r.stderr);
  console.log(`  ${ok ? '✔' : '✘'} ${label}${ok ? '' : `（退出码 ${r.code}）`}`);
  if (!ok) {
    console.error(r.stderr.split('\n').slice(0, 6).join('\n'));
    return false;
  }
  return true;
}

console.log('');
console.log(`正在实跑校验（cwd=${probeCwd}）…`);
let verifyOk = true;
verifyOk = (await probe('--version', ['--version'])) && verifyOk;
verifyOk = (await probe('help', ['help'])) && verifyOk;
verifyOk = (await probe('list', ['list'])) && verifyOk;
verifyOk = (await probe('run --dry-run', ['run', '--dry-run'])) && verifyOk;
if (!verifyOk) {
  console.error('打包失败：包内的代码跑不起来');
  process.exit(1);
}

// ---------------------------------------------------------------- zip

if (wantZip) {
  const zipFile = `${outDir}.zip`;
  console.log('');
  console.log('正在压缩…');
  const r = zipDirectory(outDir, zipFile, {
    // 加一层根目录名，解压后是一个文件夹而不是一堆散文件
    prefix: path.basename(outDir),
    onProgress: (done, total) => {
      if (done % 200 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
    },
  });
  process.stdout.write('\r');
  console.log(`  ✔ ${zipFile}`);
  console.log(`    ${r.entries} 个条目，${MB(r.rawBytes)} → ${MB(r.zipBytes)}`);
}

console.log('');
console.log('完成。把这个目录（或 zip）拷到目标机器，双击「环境自检.cmd」即可。');
