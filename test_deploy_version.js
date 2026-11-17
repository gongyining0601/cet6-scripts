#!/usr/bin/env node
'use strict';
/* ============================================================================
   test_deploy_version.js · 线上 / 本地版本一致性（**必过项**）

   为什么单独拆出来：
     test_online.js 是「在线冒烟」，整组带 opt（条件性）——网络偶尔不通时
     失败不该挡门禁。但「线上版本落后本地一版」是交付事故：用户打开网址
     拿到旧程序，而旧版行为无人负责。以前的写法把这条断言塞在 opt 用例里，
     于是 线上 v32 / 本地 v33 却仍然 GATE PASS，长期无人发现。
     本用例不带 opt，版本不一致（或压根查不到线上版本）一律挡住回归。

   输出遵循仓库约定：`ok - <name>` / `FAIL - <name>` + 结尾 `N ok / M fail`。
   用法：node test_deploy_version.js
   退出码：0 = 一致，1 = 不一致或无法确认
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOCAL_FILE = path.join(ROOT, 'app', 'version.js');
// 与 scripts/deploy_pages.js、scripts/test_online.js 保持同一个站点地址
const PAGES_VERSION = 'https://gongyining0601.github.io/cet6-trainer/version.js';

function versionOf(text) {
  const m = String(text || '').match(/CET6_VERSION\s*=\s*'(cet6-v\d+)'/);
  return m ? m[1] : null;
}

// 用 curl 而非 Node https：deploy_pages.js 已验证这条通道在本机代理下可用，
// 带 cb 参数绕开 CDN 缓存。2026-11-17 加固：本用例是**必过项**，一次 curl 超时
// 就误挡 GATE 太脆（同轮 verify_deploy.js 38/38 全过，说明是公网瞬态而非部署滞后）。
// 与 verify_deploy.js 同口径：最多 5 次、每次 25s、-f 拒绝 404 页面、间隔 2s。
// 关键：只要拿到**可解析的版本串**就立刻返回，版本是否一致仍由后面断言判定，
// 重试只针对网络失败/解析失败，绝不把「真滞后」重试成通过。
function onlineVersion() {
  let lastErr = '';
  for (let i = 1; i <= 5; i++) {
    try {
      const out = cp.execFileSync('curl',
        ['-sS', '-f', '-m', '25', PAGES_VERSION + '?cb=' + Date.now() + '-' + i],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const v = versionOf(out);
      if (v) return v;
      lastErr = '线上响应里没有可解析的版本串';
    } catch (e) { lastErr = (e.message || String(e)).split('\n')[0].slice(0, 160); }
    if (i < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error(lastErr + '（已重试 5 次）');
}

(async () => {
  const results = [];
  const check = (name, good, extra) =>
    results.push((good ? 'ok' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));

  let local = null, localErr = '';
  try { local = versionOf(fs.readFileSync(LOCAL_FILE, 'utf8')); }
  catch (e) { localErr = e.message; }
  check('本地 app/version.js 能读出版本号', !!local, local || localErr || 'null');

  let online = null, netErr = '';
  try { online = onlineVersion(); }
  catch (e) { netErr = (e.message || String(e)).split('\n')[0].slice(0, 160); }
  check('线上 version.js 可访问且能解析', !!online, online || netErr || 'null');

  // 从严：查不到线上版本也算失败——「无法确认一致」不能等同于「通过」。
  check('线上版本与本地一致（部署未滞后）', !!local && !!online && online === local,
    '线上=' + (online || '不可达') + ' 本地=' + (local || '未知'));

  console.log(results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== 部署版本一致性: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  process.exit(fails ? 1 : 0);
})();
