#!/usr/bin/env node
/**
 * 下载项目所需第三方素材（可复现，不依赖本地其它目录）。
 *
 *   node tools/fetch-assets.mjs            下载 OCR 模型 + 官方文档
 *   node tools/fetch-assets.mjs --docs     只下文档
 *   node tools/fetch-assets.mjs --ocr      只下 OCR 模型
 *
 * 说明：本机 DNS 被 fake-IP 代理接管，PowerShell/.NET 的 TLS 会失败，
 * 而 Node 的 fetch 可以正常走通 —— 因此所有下载都走 Node。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../src/util/exec.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OCR_DIR = path.join(ROOT, 'resource', 'model', 'ocr');
const DOCS_DIR = path.join(ROOT, 'docs', 'reference');

const OCR_URL =
  'https://download.maafw.xyz/MaaCommonAssets/OCR/ppocr_v5/ppocr_v5-zh_cn.zip';
const OCR_FILES = ['det.onnx', 'rec.onnx', 'keys.txt'];

const DOC_BASE = 'https://raw.githubusercontent.com/MaaXYZ/MaaFramework/v5.13.1';
const DOCS = [
  'docs/zh_cn/1.1-快速开始.md',
  'docs/zh_cn/1.2-术语解释.md',
  'docs/zh_cn/2.1-集成文档.md',
  'docs/zh_cn/2.2-集成接口一览.md',
  'docs/zh_cn/2.4-控制方式说明.md',
  'docs/zh_cn/3.1-任务流水线协议.md',
  'docs/zh_cn/5.1-问题反馈.md',
  'docs/zh_cn/NodeJS/J1.1-快速开始.md',
  'docs/zh_cn/NodeJS/J1.2-自定义识别_操作.md',
];

function log(msg) {
  process.stdout.write(msg + '\n');
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'game-auto-script' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** 递归查找文件名匹配的文件。 */
function findFiles(dir, names) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (names.includes(entry.name)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** 解压 zip：优先 bsdtar（Windows 10+ 自带），回退 PowerShell Expand-Archive。 */
async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const tar = await run('tar', ['-xf', zipPath, '-C', destDir], { timeoutMs: 120000 });
  if (tar.ok) return 'tar';

  const ps = await run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { timeoutMs: 180000 },
  );
  if (ps.ok) return 'Expand-Archive';

  throw new Error(
    `解压失败。tar: ${tar.stderr.trim().slice(0, 200)} | Expand-Archive: ${ps.stderr.trim().slice(0, 200)}`,
  );
}

async function fetchOcr() {
  log('=== OCR 模型 ===');
  const existing = OCR_FILES.filter((f) => fs.existsSync(path.join(OCR_DIR, f)));
  if (existing.length === OCR_FILES.length) {
    log(`  已存在，跳过：${OCR_DIR}`);
    return true;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wjdr-ocr-'));
  const zipPath = path.join(tmp, 'ppocr_v5-zh_cn.zip');
  try {
    log(`  下载 ${OCR_URL}`);
    const bytes = await download(OCR_URL, zipPath);
    log(`  完成 ${(bytes / 1024 / 1024).toFixed(1)} MB`);

    const extractDir = path.join(tmp, 'x');
    const how = await extractZip(zipPath, extractDir);
    log(`  解压完成（${how}）`);

    const found = findFiles(extractDir, OCR_FILES);
    const missing = OCR_FILES.filter((f) => !found.some((p) => path.basename(p) === f));
    if (missing.length) {
      throw new Error(`压缩包内缺少 ${missing.join(', ')}（实际找到：${found.map((p) => path.basename(p)).join(', ') || '无'}）`);
    }

    fs.mkdirSync(OCR_DIR, { recursive: true });
    for (const f of OCR_FILES) {
      const src = found.find((p) => path.basename(p) === f);
      fs.copyFileSync(src, path.join(OCR_DIR, f));
      const size = fs.statSync(path.join(OCR_DIR, f)).size;
      log(`  ✔ ${f} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchDocs() {
  log('=== 官方文档 ===');
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  let ok = 0;
  for (const rel of DOCS) {
    const url = `${DOC_BASE}/${encodeURI(rel)}`;
    const dest = path.join(DOCS_DIR, rel.replace(/^docs\/zh_cn\//, '').replace(/\//g, '__'));
    try {
      const bytes = await download(url, dest);
      log(`  ✔ ${path.basename(dest)} (${(bytes / 1024).toFixed(0)} KB)`);
      ok++;
    } catch (e) {
      log(`  ✘ ${rel} — ${e.message}`);
    }
  }
  log(`  完成 ${ok}/${DOCS.length} → ${DOCS_DIR}`);
  return ok > 0;
}

async function main() {
  const args = process.argv.slice(2);
  const onlyDocs = args.includes('--docs');
  const onlyOcr = args.includes('--ocr');

  let ok = true;
  if (!onlyDocs) {
    try {
      await fetchOcr();
    } catch (e) {
      log(`  ✘ OCR 下载失败：${e.message}`);
      log(`    可手工下载 ${OCR_URL}`);
      log(`    解压后把 ${OCR_FILES.join(' / ')} 放到 ${OCR_DIR}`);
      ok = false;
    }
  }
  if (!onlyOcr) {
    try {
      await fetchDocs();
    } catch (e) {
      log(`  ✘ 文档下载失败：${e.message}`);
      ok = false;
    }
  }

  log(ok ? '\n全部完成。' : '\n部分失败，见上方提示。');
  process.exit(ok ? 0 : 1);
}

main();
