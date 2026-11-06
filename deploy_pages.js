#!/usr/bin/env node
'use strict';
/* ============================================================================
   deploy_pages.js · CET6 站点部署（app 源仓库 → Pages 仓库 cet6-trainer）

   为什么需要这个脚本：
     线上 gongyining0601.github.io/cet6-trainer/ 服务自 **cet6-trainer** 仓库，
     而开发一直在 **cet6/app** 仓库。两个仓库没有任何自动同步关系，曾长期分叉
     （线上停在 P7.6 快照、本地已是 cet6-v32），net 组线上冒烟因此全红半年。
     手工整树同步靠临场记忆，既容易忘记排除开发产物，也容易误判"线上带了什么"。

   三档模式（默认只读，越往后动作越大）：
     node deploy_pages.js                  plan  ：只读推演，打印期望清单/差异/校验，不改任何文件
     node deploy_pages.js --apply          apply ：整树同步 + 排除 + 校验 + 本地提交（不推公网）
     node deploy_pages.js --push           push  ：apply + 推送 cet6-trainer + 轮询 Pages 生效

   常用参数：
     --worktree <path>   指定部署工作区（默认 <cet6>/.deploy/cet6-trainer，
                         也可用环境变量 CET6_DEPLOY_DIR）
     --src <path>        指定源仓库（默认 <cet6>/app；可指向另一个 checkout 做验证）
     --force              允许重置有未提交改动的部署工作区 / 源仓库脏时仍 --push
     --help               查看完整说明

   设计约束：
     · 部署内容取自 app 仓库 **HEAD 已提交树**，不是工作区文件；源仓库有未提交改动会明确提示。
     · 排除清单是硬规则：即使哪天 app/.gitignore 改了、源树误带素材，脚本也会二次剔除并校验。
     · 校验不通过绝不提交；部署树与 HEAD 无差异时绝不制造空提交。
     · 推公网必须显式 --push；网络不通时可先 --apply 生成提交，通了再手工 push。
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const MODE = has('--push') ? 'push' : has('--apply') ? 'apply' : 'plan';
const FORCE = has('--force');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(argVal('--src') || path.join(ROOT, 'app'));
const PAGES_URL = 'https://gongyining0601.github.io/cet6-trainer/';
const DEPLOY_REMOTE = 'https://github.com/gongyining0601/cet6-trainer.git';
const DEFAULT_WORKTREE = path.join(ROOT, '.deploy', 'cet6-trainer');

/* 开发产物 / 原始素材，一律不进站点树（前缀匹配，相对站点根） */
const EXCLUDE_DIRS = [
  'docs/', 'backup/', 'bank/json/', 'app/', 'scripts/', 'cet-audio/',
  '.scratch/', '.deploy/', 'node_modules/', '.git/'
];
const EXCLUDE_FILE = /(\.log$|\.tmp$|\.bak$|^Thumbs\.db$|^\.DS_Store$)/i;

/* 站点跑起来必须有的文件 */
const REQUIRED = [
  'index.html', 'version.js', 'core.js', 'sw.js', 'manifest.json',
  'icon-192.png', 'icon-512.png',
  'bank/meta.js', 'bank/listeningMeta.js', 'sync.js', 'sync-config.js'
];
const MIN_PAPERS = 76;   // bank/cet6-*.js 卷脚本

const WORKTREE = path.resolve(argVal('--worktree') || process.env.CET6_DEPLOY_DIR || DEFAULT_WORKTREE);

let FAILS = 0;
const say = (...a) => console.log(...a);
const ok = (s) => say('  [ok]   ' + s);
const warn = (s) => say('  [warn] ' + s);
const bad = (s) => { FAILS++; say('  [FAIL] ' + s); };
const die = (s) => { console.error('\n[中断] ' + s); process.exit(2); };

function git(cwd, args, opts) {
  opts = opts || {};
  try {
    return cp.execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024
    });
  } catch (e) {
    if (opts.allowFail) return (e.stdout || '') + '';
    const msg = ((e.stderr || '') + ' ' + (e.message || '')).trim().slice(0, 400);
    throw new Error('git ' + args.slice(0, 4).join(' ') + ' 失败：' + msg);
  }
}
const gitPath = (p) => p.replace(/\\/g, '/');
const isRepo = (p) => { try { return fs.statSync(path.join(p, '.git')).isDirectory(); } catch (e) { return false; } };

/** 读一棵 git 树：Map<相对路径, blob hash>。-z 保证中文路径不被 quote */
function treeOf(repo, ref) {
  const out = git(repo, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', ref || 'HEAD']);
  const map = new Map();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const hash = rec.slice(0, tab).trim().split(/\s+/)[2];
    map.set(rec.slice(tab + 1), hash);
  }
  return map;
}
const excluded = (p) => EXCLUDE_DIRS.some((d) => p.startsWith(d)) || EXCLUDE_FILE.test(path.posix.basename(p));
const papersOf = (list) => list.filter((p) => /^bank\/cet6-.*\.js$/.test(p)).length;

function versionOf(fileText) {
  const m = (fileText || '').match(/CET6_VERSION\s*=\s*'(cet6-v\d+)'/);
  return m ? m[1] : null;
}
function onlineVersion() {
  try {
    const s = cp.execFileSync('curl', ['-s', '-m', '15', PAGES_URL + 'version.js?cb=' + Date.now()],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return versionOf(s);
  } catch (e) { return null; }
}

/** 对一份文件清单做部署前校验，返回 {version, count, bytes} */
function validate(list, filesDir, label) {
  say('\n[' + label + ' · 部署前校验]');
  const leftovers = list.filter(excluded);
  if (leftovers.length) bad('排除清单有残留 ' + leftovers.length + ' 个：' + leftovers.slice(0, 5).join(', '));
  else ok('排除清单干净（docs / backup / bank/json / *.log 等 0 个）');

  const miss = REQUIRED.filter((f) => !list.includes(f));
  if (miss.length) bad('缺少必需文件：' + miss.join(', '));
  else ok('必需文件齐全（' + REQUIRED.length + ' 项）');

  const n = papersOf(list);
  if (n < MIN_PAPERS) bad('题库卷脚本只有 ' + n + ' 个，少于 ' + MIN_PAPERS);
  else ok('题库卷脚本 ' + n + ' 个');

  let version = null;
  try {
    const vText = fs.readFileSync(path.join(filesDir, 'version.js'), 'utf8');
    version = versionOf(vText);
    const srcV = versionOf(fs.readFileSync(path.join(SRC, 'version.js'), 'utf8'));
    if (!version) bad('version.js 里找不到 CET6_VERSION');
    else if (version !== srcV) bad('version.js 与源仓库不一致：部署=' + version + ' 源=' + srcV);
    else ok('版本号与源仓库一致：' + version);

    const html = fs.readFileSync(path.join(filesDir, 'index.html'), 'utf8');
    const htmlV = (html.match(/cet6-v\d+/g) || []);
    if (!version || htmlV.some((v) => v !== version)) bad('index.html 版本兜底串与 version.js 不一致：' + [...new Set(htmlV)].join(','));
    else ok('index.html 版本兜底串一致');
  } catch (e) {
    bad('读取站点文件失败：' + e.message.slice(0, 160));
  }

  let bytes = 0;
  for (const p of list) { try { bytes += fs.statSync(path.join(filesDir, p)).size; } catch (e) { } }
  return { version, count: list.length, bytes };
}

/* ---------------------------------------------------------------- plan ---- */
function plan() {
  say('===== CET6 部署推演（只读，不修改任何文件）=====');
  say('模式      : plan');
  say('源仓库    : ' + SRC);
  say('部署工作区: ' + WORKTREE + (isRepo(WORKTREE) ? '（已存在）' : '（尚未创建）'));

  const head = git(SRC, ['rev-parse', '--short', 'HEAD']).trim();
  const dirty = git(SRC, ['status', '--porcelain']).trim();
  say('源 HEAD   : ' + head + (dirty ? '  [warn] 有未提交改动，部署基于 HEAD，不含这些改动' : '（工作区干净）'));

  const src = treeOf(SRC, 'HEAD');
  const expected = [...src.keys()].filter((p) => !excluded(p)).sort();
  const dropped = [...src.keys()].filter(excluded).sort();
  say('\n[源树 → 期望站点树]');
  say('  源树 ' + src.size + ' 个文件 → 部署 ' + expected.length + ' 个，按规则排除 ' + dropped.length + ' 个');
  if (dropped.length) say('  排除明细: ' + dropped.join(', '));

  if (isRepo(WORKTREE)) {
    const cur = treeOf(WORKTREE, 'HEAD');
    const curKept = [...cur.keys()].filter((p) => !excluded(p));
    const set = new Set(expected), curSet = new Set(curKept);
    const added = expected.filter((p) => !curSet.has(p));
    const removed = curKept.filter((p) => !set.has(p));
    const changed = expected.filter((p) => curSet.has(p) && cur.get(p) !== src.get(p));
    say('\n[与部署工作区 HEAD 的差异]');
    say('  当前 ' + curKept.length + ' 个文件 → 新增 ' + added.length + ' / 删除 ' + removed.length + ' / 内容变更 ' + changed.length);
    if (added.length) say('  新增: ' + added.slice(0, 8).join(', '));
    if (removed.length) say('  删除: ' + removed.slice(0, 8).join(', '));
    if (changed.length) say('  变更: ' + changed.slice(0, 8).join(', '));
    if (!added.length && !removed.length && !changed.length) ok('部署树已与源一致，无需同步');
  } else {
    say('\n[与部署工作区 HEAD 的差异]');
    warn('部署工作区不存在，--apply 时会先从 ' + DEPLOY_REMOTE + ' 克隆（需要网络）');
  }

  const r = validate(expected, SRC, 'plan');
  say('  体积    : ' + (r.bytes / 1024 / 1024).toFixed(2) + ' MB');

  const online = onlineVersion();
  say('\n[线上现状]');
  if (!online) warn('线上 version.js 暂不可达（网络/代理），跳过版本比对');
  else if (online !== r.version) warn('线上 ' + online + ' ≠ 本地 ' + r.version + '，部署滞后，建议 --apply 后 --push');
  else ok('线上版本 ' + online + ' 与本地一致');

  say('\n[结论] ' + (FAILS ? FAILS + ' 项校验不通过，禁止部署' : '校验通过，可执行部署'));
  say('  下一步: node deploy_pages.js --apply        （本地生成部署提交，不推公网）');
  say('          node deploy_pages.js --push         （推送并等待 Pages 生效）');
  if (FAILS) process.exit(1);
}

/* --------------------------------------------------------------- apply ---- */
function ensureWorktree() {
  if (isRepo(WORKTREE)) {
    const st = git(WORKTREE, ['status', '--porcelain']).trim();
    if (st && !FORCE) die('部署工作区有未提交改动：\n' + st.slice(0, 500) + '\n确认要丢弃请加 --force');
    let fetched = true;
    try { git(WORKTREE, ['fetch', 'origin', 'main']); } catch (e) { fetched = false; }
    if (fetched) ok('部署工作区已就绪（' + WORKTREE + '），origin 已刷新');
    else warn('origin fetch 未成功（离线？）——本次仍可生成提交，但推送需联网');
    return;
  }
  say('  部署工作区不存在，克隆 ' + DEPLOY_REMOTE + ' …');
  fs.mkdirSync(path.dirname(WORKTREE), { recursive: true });
  git(ROOT, ['clone', DEPLOY_REMOTE, WORKTREE]);
  ok('克隆完成');
}

function apply() {
  say('===== CET6 部署（' + MODE + '）=====');
  const head = git(SRC, ['rev-parse', '--short', 'HEAD']).trim();
  const dirty = git(SRC, ['status', '--porcelain']).trim();
  if (dirty) {
    if (MODE === 'push' && !FORCE) die('源仓库 app 有未提交改动，拒绝推公网（避免发旧版）；确认请加 --force');
    warn('源仓库 app 有未提交改动，部署基于 HEAD ' + head + '，不含这些改动');
  }

  say('\n[1/5] 准备部署工作区');
  ensureWorktree();

  say('\n[2/5] 整树同步（源 HEAD ' + head + ' → 部署索引）');
  git(WORKTREE, ['fetch', gitPath(SRC), 'main']);
  git(WORKTREE, ['read-tree', '-u', '--reset', 'FETCH_HEAD']);
  ok('已按源树重建索引与工作区');

  say('\n[3/5] 二次剔除开发产物（不依赖 app/.gitignore）');
  for (const d of ['docs', 'backup', 'bank/json', 'app', 'scripts', 'cet-audio', '.scratch']) {
    git(WORKTREE, ['rm', '-r', '-f', '-q', '--ignore-unmatch', '--', d], { allowFail: true });
  }
  const idx = git(WORKTREE, ['-c', 'core.quotePath=false', 'ls-files', '-z']).split('\0').filter(Boolean);
  for (const p of idx.filter((p) => excluded(p))) {
    git(WORKTREE, ['rm', '-f', '-q', '--ignore-unmatch', '--', p], { allowFail: true });
  }
  ok('排除规则已应用');

  say('\n[4/5] 校验');
  const list = git(WORKTREE, ['-c', 'core.quotePath=false', 'ls-files', '-z']).split('\0').filter(Boolean).sort();
  const r = validate(list, WORKTREE, 'apply');
  say('  文件 ' + r.count + ' 个 / ' + (r.bytes / 1024 / 1024).toFixed(2) + ' MB');
  if (FAILS) die(FAILS + ' 项校验不通过：未生成任何提交，部署工作区留在可检查状态');

  say('\n[5/5] 提交');
  const status = git(WORKTREE, ['status', '--porcelain']).trim();
  if (!status) { ok('部署树与 HEAD 完全一致，无变更，跳过提交（不制造空提交）'); return { noChange: true, version: r.version }; }

  const msg = 'deploy: 同步 ' + path.basename(SRC) + '@' + head + '（' + r.version + '）站点树\n\n'
    + '由 scripts/deploy_pages.js 整树同步生成；已剔除 docs/backup/bank/json 等开发产物，\n'
    + '并通过必需文件、题库卷数、版本号一致性校验。';
  const ident = ['-c', 'user.name=' + (process.env.CET6_GIT_NAME || 'gongyining0601'),
    '-c', 'user.email=' + (process.env.CET6_GIT_EMAIL || 'gongyining0601@users.noreply.github.com')];
  git(WORKTREE, ident.concat(['add', '-A']));
  git(WORKTREE, ident.concat(['commit', '-q', '-m', msg]));
  const commit = git(WORKTREE, ['rev-parse', '--short', 'HEAD']).trim();
  ok('本地部署提交 ' + commit);
  return { noChange: false, version: r.version, commit };
}

function pushAfter(result) {
  say('\n[推送公网]');
  if (result.noChange) {
    const ahead = git(WORKTREE, ['log', '--oneline', 'origin/main..HEAD'], { allowFail: true }).trim();
    if (!ahead) { ok('部署仓库无待推提交，线上已是最新，跳过推送'); return; }
    warn('本次无新提交，但有 ' + ahead.split('\n').length + ' 个历史提交待推，继续推送');
  }
  try {
    git(WORKTREE, ['push', 'origin', 'HEAD:main']);
    ok('已推送 cet6-trainer main');
  } catch (e) {
    die('推送失败（网络/代理通道），本地提交仍在，通道恢复后执行：\n'
      + '  git -C "' + WORKTREE + '" push origin HEAD:main\n原因：' + e.message);
  }

  say('\n[轮询 Pages 生效]');
  const target = result.version;
  for (let i = 1; i <= 8; i++) {
    const v = onlineVersion();
    say('  [' + i + '/8] 线上 version.js = ' + (v || '不可达'));
    if (v === target) { ok('Pages 已更新到 ' + target + '，可跑 net 组冒烟：node run_all.js --only=online'); return; }
    // 同步等待 30s（Atomics.wait 不占 CPU；Pages 有 max-age=600 + CDN 缓存）
    if (i < 8) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  }
  warn('4 分钟内未确认线上版本（CDN 缓存或网络），请稍后手工核对 ' + PAGES_URL + 'version.js');
}

function help() {
  const doc = fs.readFileSync(__filename, 'utf8').split('*/')[0]
    .replace(/^[\s\S]*?\/\*+/, '')
    .split('\n').filter((l) => !/^\s*=+\s*$/.test(l)).join('\n').trim();
  say(doc);
  say('\n补充：');
  say('  · 线上站点 = cet6-trainer 仓库的 main 分支（GitHub Pages），源 = cet6/app 仓库的 main。');
  say('  · 两仓库历史独立，脚本用 read-tree 做整树替换，不依赖共同祖先。');
  say('  · 部署工作区默认 ' + DEFAULT_WORKTREE + '，已在根 .gitignore 排除。');
  say('  · 身份可用 CET6_GIT_NAME / CET6_GIT_EMAIL 覆盖；代理故障时先 --apply，通了再手工 push。');
}

if (has('--help') || has('-h')) help();
else if (MODE === 'plan') plan();
else {
  const result = apply();
  if (MODE === 'push') pushAfter(result);
  else say('\n[完成] ' + (result.noChange
    ? '部署树与源一致，未生成提交、未推送'
    : '仅生成本地提交，未推公网。确认无误后执行 node deploy_pages.js --push'));
}
