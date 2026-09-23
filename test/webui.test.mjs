/**
 * 控制台静态资源的用例。
 *
 * 分两层：
 *  1. `resolveWebuiFile` 是纯函数，直接断言路径归一化与越界防护；
 *  2. 用临时目录当构建产物，起一个真的 HTTP 服务断言响应头与回落行为。
 *
 * 单独一个文件的原因：`test/web.test.mjs` 断言的是内联兜底页，
 * 而本机只要构建过 `src/webui/dist`，自动探测就会换成 Vue 控制台。
 * 两边各自显式指定，互不影响。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startWebServer, resolveWebuiFile } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';
import * as events from '../src/events.mjs';

const { config } = loadConfig();
const silent = { debug() {}, info() {}, warn() {}, error() {} };

let distDir = '';
let server = null;
let base = '';

const fakeRunner = {
  getRunState: () => ({ ...events.state }),
  async start() {},
  async stop() {},
};

before(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjdr-webui-'));
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<!DOCTYPE html><html lang="zh-CN"><head><title>无尽冬日控制台</title></head><body><div id="app"></div></body></html>',
  );
  fs.writeFileSync(path.join(distDir, 'assets', 'app-abc123.js'), 'console.log("ok");\n');
  // 放一个「不该被读到」的邻居文件，用来验证越界防护
  fs.writeFileSync(path.join(path.dirname(distDir), `${path.basename(distDir)}-secret.txt`), 'SECRET\n');

  events.resetForTest();
  server = await startWebServer({
    config,
    logger: silent,
    runner: fakeRunner,
    port: 0,
    appVersion: '9.9.9',
    webuiDir: distDir,
  });
  base = server.url.replace(/\/$/, '');
});

after(async () => {
  await server?.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ 纯函数

test('resolveWebuiFile: 无扩展名的路径回落到 index.html', () => {
  for (const route of ['/', '/tasks', '/pipelines/10_%E8%81%94%E7%9B%9F%E6%97%A5%E5%B8%B8']) {
    const hit = resolveWebuiFile(distDir, route);
    assert.ok(hit, `${route} 应当命中`);
    assert.equal(hit.fallback, true);
    assert.equal(hit.file, path.join(path.resolve(distDir), 'index.html'));
  }
});

test('resolveWebuiFile: 认识的静态资源直接命中', () => {
  const hit = resolveWebuiFile(distDir, '/assets/app-abc123.js');
  assert.equal(hit.fallback, false);
  assert.equal(hit.file, path.join(path.resolve(distDir), 'assets', 'app-abc123.js'));
});

test('resolveWebuiFile: 越界路径不会逃出构建目录', () => {
  const root = path.resolve(distDir);
  for (const route of [
    '/../secret.txt',
    '/../../secret.txt',
    '/..%2f..%2fsecret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/%2e%2e/package.json',
    '/....//....//package.json',
  ]) {
    const hit = resolveWebuiFile(distDir, route);
    if (hit) {
      assert.ok(
        hit.file === root || hit.file.startsWith(root + path.sep),
        `${route} 解析成了目录外的路径：${hit.file}`,
      );
    }
  }
});

test('resolveWebuiFile: 不认识的扩展名与非法输入返回 null', () => {
  assert.equal(resolveWebuiFile(distDir, '/evil.exe'), null);
  assert.equal(resolveWebuiFile(distDir, '/data.bin'), null);
  assert.equal(resolveWebuiFile(distDir, '/%ZZ'), null, '非法百分号编码');
  assert.equal(resolveWebuiFile(distDir, '/a%00b.js'), null, '空字节');
  assert.equal(resolveWebuiFile(distDir, ''), null);
  assert.equal(resolveWebuiFile(distDir, null), null);
  assert.equal(resolveWebuiFile(null, '/'), null);
});

// ------------------------------------------------------------ 真实 HTTP

test('GET /: 返回构建产物的 index.html', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('cache-control'), /no-cache/, 'index.html 不能长缓存');
  assert.match(await r.text(), /无尽冬日控制台/);
});

test('GET /assets/*: 带哈希的资源可以长缓存', async () => {
  const r = await fetch(`${base}/assets/app-abc123.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.match(await r.text(), /console\.log/);
});

test('GET 未命中的前端路由: 回落到 index.html（SPA）', async () => {
  const r = await fetch(`${base}/some/spa/route`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /无尽冬日控制台/);
});

test('GET 缺失的静态资源: 404，不回落成 HTML', async () => {
  const r = await fetch(`${base}/assets/missing-xyz.js`);
  assert.equal(r.status, 404);
});

test('GET 越界路径: 读不到构建目录之外的文件', async () => {
  const r = await fetch(`${base}/..%2f..%2f${path.basename(distDir)}-secret.txt`);
  const text = await r.text();
  assert.ok(!text.includes('SECRET'), '不应该读到构建目录之外的内容');
});

test('没有构建产物时: 回落到内联页并如实报告', async () => {
  const missing = path.join(distDir, 'not-built');
  const s = await startWebServer({
    config,
    logger: silent,
    runner: fakeRunner,
    port: 0,
    appVersion: '9.9.9',
    webuiDir: missing,
  });
  try {
    assert.equal(s.webui, null, '目录里没有 index.html 时应当回落');
    const r = await fetch(s.url);
    const html = await r.text();
    assert.match(html, /无尽冬日/);
    assert.match(html, /EventSource/, '内联页用原生 EventSource');
  } finally {
    await s.close();
  }
});

test('startWebServer: webui 字段报告实际使用的控制台目录', () => {
  assert.equal(server.webui, distDir);
});
