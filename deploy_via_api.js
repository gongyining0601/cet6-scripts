#!/usr/bin/env node
'use strict';
/* ============================================================================
   deploy_via_api.js · git push 被代理拦截时的 API 通道（部署脚本自动回退用）

   本机常见故障：github.com 走代理返回 "CONNECT tunnel failed, 502"，
   但 api.github.com（gh CLI 所用域名）可通。此时 git push 必失败，
   但部署提交已在 .deploy/cet6-trainer 生成，只差推上去。

   与「把文件打成一个新提交」的常规 API 推送不同，这里**精确重放本地提交**：
   tree 用 base_tree + 变更文件重建，commit 连 author / committer / 两端时间
   / message / parent 都按本地元数据填，因此远端 commit sha 与本地 HEAD
   **完全相同** —— 部署工作区不会与远端分叉，下次发版可以直接 fast-forward。

   安全：远端 HEAD 必须等于本地 parent，否则拒绝覆盖（防并发提交）。
   用法：node deploy_via_api.js [--worktree <path>] [--repo owner/repo]
   退出码：0 = 成功且两端对齐，1 = 失败，2 = 远端状态不符（已中止）
   ============================================================================ */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const ROOT = path.resolve(__dirname, '..');
const LOCAL = path.resolve(val('--worktree') || process.env.CET6_DEPLOY_DIR || path.join(ROOT, '.deploy', 'cet6-trainer'));
const BRANCH = val('--branch') || 'main';
let REPO = val('--repo');
if (!REPO) {
  const url = cp.execFileSync('git', ['-C', LOCAL, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
  if (!m) { console.error('[失败] 无法从 origin 解析仓库：' + url); process.exit(1); }
  REPO = m[1];
}

function git(args, asText) {
  const b = cp.execFileSync('git', ['-C', LOCAL, '-c', 'core.quotepath=false'].concat(args),
    { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return asText === false ? b : b.toString('utf8');
}
function ghGet(endpoint, jq) {
  const args = ['api', endpoint];
  if (jq) args.push('--jq', jq);
  return cp.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function ghWrite(method, endpoint, body) {
  const tmp = path.join(os.tmpdir(), 'cet6-deploy-api-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
  try {
    return JSON.parse(cp.execFileSync('gh', ['api', '-X', method, endpoint, '--input', tmp],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally { try { fs.unlinkSync(tmp); } catch (e) { } }
}

(async () => {
  const head = git(['rev-parse', 'HEAD']).trim();
  const parent = git(['rev-parse', 'HEAD^']).trim();
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  const parentTree = git(['rev-parse', 'HEAD^^{tree}']).trim();
  const m = git(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI']).replace(/\n$/, '').split('\0');
  const message = git(['log', '-1', '--format=%B']).replace(/\n$/, '');
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n').filter(Boolean);
  const remoteHead = ghGet(`repos/${REPO}/git/ref/heads/${BRANCH}`, '.object.sha');

  console.log('仓库 ' + REPO + '@' + BRANCH + ' | 本地 ' + head.slice(0, 7) + ' | 远端 ' + remoteHead.slice(0, 7));
  if (remoteHead === head) { console.log('远端已与本地一致，无需推送'); return; }
  if (remoteHead !== parent) {
    console.error('[中止] 远端 HEAD 不是本地 parent（可能并发提交），拒绝覆盖');
    process.exit(2);
  }
  console.log('待推文件 ' + files.length + ' 个：' + files.slice(0, 8).join(', ') + (files.length > 8 ? ' …' : ''));

  // 只适合文本文件改动；二进制/大文件用 base64 blob API 会更复杂，这里显式挡住
  const entries = files.map(f => {
    const mode = git(['ls-tree', 'HEAD', '--', f]).trim().split(/\s+/)[0] || '100644';
    const blob = git(['cat-file', 'blob', 'HEAD:' + f], false);
    if (blob.indexOf(0) >= 0) throw new Error('检测到二进制文件 ' + f + '，API 精确重放不支持，请改走其他通道');
    return { path: f, mode: mode, type: 'blob', content: blob.toString('utf8') };
  });
  const newTree = ghWrite('POST', `repos/${REPO}/git/trees`, { base_tree: parentTree, tree: entries });
  if (newTree.sha !== tree) throw new Error('API 重建的树与本地不一致（' + newTree.sha + ' ≠ ' + tree + '），已中止');

  const c = ghWrite('POST', `repos/${REPO}/git/commits`, {
    message: message, tree: newTree.sha, parents: [parent],
    author: { name: m[0], email: m[1], date: m[2] },
    committer: { name: m[3], email: m[4], date: m[5] }
  });
  if (c.sha !== head) throw new Error('API 重建的提交 sha 与本地不一致（' + c.sha + ' ≠ ' + head + '），已中止');

  ghWrite('PATCH', `repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: c.sha });
  const after = ghGet(`repos/${REPO}/git/ref/heads/${BRANCH}`, '.object.sha');
  if (after !== head) throw new Error('引用更新后远端 HEAD 与本地不一致');
  console.log('已推送 ' + head.slice(0, 7) + '，远端与本地完全对齐（无分叉）');
})().catch(e => { console.error('[失败] ' + e.message); process.exit(1); });
