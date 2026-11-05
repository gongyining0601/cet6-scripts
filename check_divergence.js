/* scripts/check_divergence.js —— 双项目防漏修闸门（CET4 / CET6 共用，两仓字节一致）
 *
 * 背景：CET4 是从 CET6 复制分叉出来的孪生项目，历史上出现过「CET6 修了 6 项、
 * CET4 一项都没跟」的漏修。人工复制不可靠，所以把「必须一致」与「必须都有」写成断言。
 *
 * 检查三类：
 *   A. 共享内核：下列文件两仓必须字节一致（差异只允许出现在 sync-config.js / 配置里）；
 *   B. 修复点：一组「上游已修、下游必须跟」的特征串，两边都要命中；
 *   C. 允许差异：PLAN_VERSION、namespace 等必须各自保持正确值，不能被覆盖成一样。
 *
 * 用法：node scripts/check_divergence.js
 *       CET_PEER_ROOT=D:\CET6 node scripts/check_divergence.js   （兄弟目录不在同级时）
 *       CET_UPSTREAM=CET4 node scripts/check_divergence.js       （改由 CET4 主导时）
 * 挂进两边 run_all.js 的 core 组；发现漏修直接非零退出。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ME = path.basename(ROOT).toUpperCase();
const DEFAULT_PEER = path.join(path.dirname(ROOT), ME === 'CET4' ? 'CET6' : 'CET4');
const PEER = process.env.CET_PEER_ROOT || DEFAULT_PEER;
const PEER_OK = fs.existsSync(path.join(PEER, 'app', 'index.html'));
const UPSTREAM = (process.env.CET_UPSTREAM || 'CET6').toUpperCase();

let ok = 0, fail = 0;
const missing = [];
function chk(name, cond, detail) {
  if (cond) { ok++; console.log('ok   ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}
function read(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e) { return ''; }
}
function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12); }

console.log('===== 双项目分叉检查 =====');
console.log('本项目: ' + ROOT);
console.log('对照项目: ' + PEER + (PEER_OK ? '' : '  [不存在 → 跳过跨项目比对]'));
console.log('登记上游: ' + UPSTREAM + '（改由另一项目主导时设 CET_UPSTREAM）');
console.log('');

// ---------- A. 共享内核必须字节一致 ----------
const SHARED = [
  'app/sync.js',
  'scripts/sync-server.js',
  'scripts/test_sync.js',
  'scripts/bump_version.js',
  'scripts/test_version_sync.js',
  'scripts/_bump_ver.py'
];
SHARED.forEach(function (rel) {
  const a = read(ROOT, rel);
  chk('共享内核存在 ' + rel, a.length > 0, sha(a));
  if (PEER_OK) {
    const b = read(PEER, rel);
    chk('两仓字节一致 ' + rel, a.length > 0 && a === b, sha(a) + ' / ' + sha(b));
  }
});

// ---------- B. 修复点：两边都必须命中 ----------
const FIXES = [
  { n: '静态 CSP（file:// 与 https 同时生效）', f: 'app/index.html', re: /<meta\s+http-equiv="Content-Security-Policy"/ },
  { n: '作文保存防抖', f: 'app/index.html', re: /essaySaveTimer/ },
  { n: '4 位编号撞号提示', f: 'app/index.html', re: /1 万种组合/ },
  { n: '未到期错题在 innerHTML 之后绑定', f: 'app/index.html', re: /绑定必须在 innerHTML 之后/ },
  { n: '错题/考点练习剔幽灵 qid', f: 'app/index.html', re: /ids\.filter\(function \(id\) \{ return !!C\.findQ/ },
  { n: '听力主线路为 GitHub Pages', f: 'app/index.html', re: /var LISTEN_PRIMARY = 'https:\/\/gongyining0601\.github\.io\/cet-audio'/ },
  { n: '听力线路会话内复用', f: 'app/index.html', re: /function getGoodBase/ },
  { n: '同步层 save() 接线', f: 'app/index.html', re: /CET_SYNC\.schedulePush\(\)/ },
  { n: '同步状态卡片', f: 'app/index.html', re: /id="syncStatus"/ },
  { n: '同步口令首次输入（不写死配置）', f: 'app/index.html', re: /CET_SYNC\.setToken\(t\)/ },
  { n: 'history 730 天裁剪', f: 'app/core.js', re: /-730/ },
  { n: 'SW 骨架走网络优先', f: 'app/sw.js', re: /isMetaIndex/ },
  { n: 'SW 预缓存同步层脚本', f: 'app/sw.js', re: /'\.\/sync\.js'/ },
  { n: 'gen_meta 调共享版本递增', f: 'scripts/gen_meta.js', re: /bump_version\.js/ },
  { n: '回归含同步用例', f: 'scripts/run_all.js', re: /test_sync\.js/ },
  { n: '回归含版本/外壳闸门', f: 'scripts/run_all.js', re: /test_version_sync\.js/ },
  { n: '回归含分叉闸门', f: 'scripts/run_all.js', re: /check_divergence\.js/ }
];
const roots = PEER_OK ? [ROOT, PEER] : [ROOT];
roots.forEach(function (root) {
  const tag = path.basename(root).toUpperCase();
  FIXES.forEach(function (fx) {
    const hit = fx.re.test(read(root, fx.f));
    chk(tag + ' 已修「' + fx.n + '」', hit, fx.f);
    if (!hit) missing.push(tag + ' 缺少 ' + fx.n + '（' + fx.f + '）');
  });
});

// ---------- C. 允许差异：必须各自保持正确值 ----------
const expectPlan = { CET4: 9, CET6: 8 };  // 四级听力分片烘焙数据比六级高 1，不能互相覆盖
[ROOT].concat(PEER_OK ? [PEER] : []).forEach(function (root) {
  const tag = path.basename(root).toUpperCase();
  const m = /CORE\.PLAN_VERSION\s*=\s*(\d+)/.exec(read(root, 'app/core.js'));
  chk(tag + ' PLAN_VERSION 保持 ' + (expectPlan[tag] || '?'), !!m && Number(m[1]) === expectPlan[tag], m ? m[1] : '缺失');
  const ns = /namespace:\s*'([^']+)'/.exec(read(root, 'app/sync-config.js'));
  chk(tag + ' sync-config namespace = ' + tag.toLowerCase(), !!ns && ns[1] === tag.toLowerCase(), ns ? ns[1] : '缺失');
});
if (PEER_OK) {
  const p4 = /CORE\.PLAN_VERSION\s*=\s*(\d+)/.exec(read(ME === 'CET4' ? ROOT : PEER, 'app/core.js'));
  const p6 = /CORE\.PLAN_VERSION\s*=\s*(\d+)/.exec(read(ME === 'CET6' ? ROOT : PEER, 'app/core.js'));
  chk('两项目 PLAN_VERSION 确实不同（4 级比 6 级高 1）', !!p4 && !!p6 && Number(p4[1]) === Number(p6[1]) + 1,
    (p4 ? p4[1] : '?') + ' / ' + (p6 ? p6[1] : '?'));
}

console.log('');
if (missing.length) {
  console.log('----- 上游已修、下游未跟（需补齐） -----');
  missing.forEach(function (s) { console.log('  · ' + s); });
  console.log('');
}
console.log('===== 分叉检查: ' + ok + ' ok / ' + fail + ' fail | 漏修 ' + missing.length + ' 项 =====');
process.exit(fail ? 1 : 0);
