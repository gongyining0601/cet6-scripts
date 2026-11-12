#!/usr/bin/env node
'use strict';
/* ============================================================================
   verify_deploy.js · 部署后「线上内容 == 源树」逐字节校验（必过项）

   为什么不能只查版本号：
     version.js 只是单个小文件。CDN/Pages 构建可能让 version.js 先更新、
     index.html / core.js / bank/* 仍是旧版，此时 test_deploy_version.js 会
     报「一致」而用户实际打开的是混合版本。2026-11-12 排查线上写译卡时
     就先做了这项比对，才排除掉「部署半吊子」这个假设。

   做法：对关键文件与抽样卷分别取线上字节与本地字节，比较 SHA-256。
     curl -f 保证 404 页面不会被当成正常内容；每个文件最多重试 5 次、
     间隔 3s（2026-11-12 全量 net 组实测：3 次重试仍会被 CDN 瞬态误挡，
     而该用例是必过项，单跑随即 38/38，故把重试窗口加宽到 ~15s+）。

   输出遵循仓库约定：ok - <name> / FAIL - <name> + 汇总行。
   产物：docs/deploy-integrity-result.json
   用法：node verify_deploy.js
   退出码：0 = 全部一致，1 = 有不一致或无法确认
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const BASE = 'https://gongyining0601.github.io/cet6-trainer/';
const DOCS = path.join(ROOT, 'docs');

// 外壳 + 骨架 + 抽查卷（新/中/老各一，覆盖按需加载路径）
const FILES = [
  'index.html', 'core.js', 'version.js', 'sw.js', 'sync.js', 'sync-config.js',
  'manifest.json', 'bank/meta.js', 'bank/listeningMeta.js',
  'bank/cet6-2026-06-3.js', 'bank/cet6-2021-06-1.js', 'bank/cet6-2015-06-1.js'
];

// 统一行尾再比：本机 git autocrlf 可能让工作区是 CRLF、而 Pages 提供 LF，
// 这种 1 字节差异不是部署事故（实测 bank/listeningMeta.js 就是这种）。
const norm = b => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const sha = b => crypto.createHash('sha256').update(norm(b)).digest('hex').slice(0, 16);

// 部署脚本取的是 app 仓库 **HEAD 树**，不是工作区。补一条 HEAD 比对，
// 防止「本地改了没提交、线上还是旧的」被行尾规范化掩盖过去。
function headBlob(rel) {
  try {
    return cp.execFileSync('git', ['-C', APP, 'show', 'HEAD:' + rel],
      { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return null; }
}

function fetchOnline(rel) {
  for (let i = 1; i <= 5; i++) {
    try {
      const buf = cp.execFileSync('curl',
        ['-sS', '-f', '-m', '30', BASE + rel + '?cb=' + Date.now() + '-' + i],
        { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      if (buf && buf.length) return buf;
    } catch (e) { /* CDN 尚未刷新或瞬态；重试 */ }
    if (i < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  return null;
}

const results = [];
const rows = [];
function check(name, good, extra) {
  results.push((good ? 'ok' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));
  rows.push({ name, pass: !!good, extra: extra || '' });
}

const online = {};
FILES.forEach(rel => {
  const localPath = path.join(APP, rel);
  if (!fs.existsSync(localPath)) { check(rel + ' 本地文件存在', false, '缺失 ' + localPath); return; }
  const local = fs.readFileSync(localPath);
  const remote = fetchOnline(rel);
  online[rel] = remote;
  check(rel + ' 线上可取', !!remote, remote ? remote.length + ' 字节' : 'curl -f 三次均失败（404/超时）');
  if (!remote) return;
  // 防止把 GitHub Pages 的 404 HTML 当成 JS 内容
  const looksHtml = /^\s*<!DOCTYPE|^\s*<html/i.test(remote.slice(0, 200).toString('utf8'));
  const isJs = /\.js$/.test(rel);
  check(rel + ' 不是 404 页面', !(isJs && looksHtml));
  const a = sha(local), b = sha(remote);
  check(rel + ' 内容与源树逐字节一致', a === b, '本地=' + a + ' 线上=' + b);
});

// 版本号作为独立语义断言，便于人一眼看懂
const lv = /CET6_VERSION\s*=\s*'(cet6-v\d+)'/.exec(fs.readFileSync(path.join(APP, 'version.js'), 'utf8'));
const ov = online['version.js'] ? /CET6_VERSION\s*=\s*'(cet6-v\d+)'/.exec(online['version.js'].toString('utf8')) : null;
check('线上版本号与本地一致', !!lv && !!ov && lv[1] === ov[1], '本地=' + (lv ? lv[1] : '?') + ' 线上=' + (ov ? ov[1] : '?'));

// 部署取的是 app 仓库 HEAD 树：再核一遍，防止「本地改了没提交、线上还是旧的」
// 被行尾规范化掩盖过去。非 git 环境（精简 checkout）只记 fact，不冒充通过。
let headChecked = 0;
const headDiff = [];
FILES.forEach(rel => {
  const head = headBlob(rel);
  if (!head || !online[rel]) return;
  headChecked++;
  if (sha(head) !== sha(online[rel])) headDiff.push(rel);
});
if (headChecked) {
  check('线上受检文件与 app HEAD 树一致', headDiff.length === 0,
    headDiff.length ? '不一致: ' + headDiff.join(', ') : '核对 ' + headChecked + ' 个文件');
} else {
  console.log('fact  - 非 git 环境，HEAD 树比对未执行');
}

const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(results.join('\n'));
console.log('=== 部署内容一致性: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');

try {
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'deploy-integrity-result.json'), JSON.stringify({
    ts: new Date().toISOString(), base: BASE, method: 'curl -f + SHA-256 逐字节比对',
    files: FILES, rows, ok: results.length - fails, fail: fails, verdict: fails ? 'FAIL' : 'PASS'
  }, null, 2), 'utf8');
} catch (e) { /* 证据写失败不影响判定 */ }
process.exit(fails ? 1 : 0);
