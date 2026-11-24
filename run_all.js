#!/usr/bin/env node
'use strict';
/* ============================================================================
   run_all.js · 一键回归（CET6）
   目的：把 scripts/ 下散落的几十个用例收拢成一次可复现的运行，并且**堵死"假绿"**：
         · 退出码 0 但总断言数为 0        → 判 NO-ASSERT（失败）
         · 有 FAIL 断言却 exit 0          → 判 FAIL
         · 脚本在断言数为 0 前就崩了       → 判 NO-ASSERT / CRASH
         · 套件整体缩水（低于该脚本的断言下限）→ 判 SHRUNK（失败）
   这些正是本仓库此前最严重的测试问题：脚本"跑完了"就报通过，实际什么都没验。

   用法：
     node run_all.js                     # 全量（串行）
     node run_all.js --group=core        # 只跑纯逻辑/Node 侧用例
     node run_all.js --group=browser     # 只跑需要浏览器的用例
     node run_all.js --only=security     # 文件名含 security
     node run_all.js --timeout=600000    # 单个用例超时（毫秒），默认 480000
     node run_all.js --list              # 只列清单不执行
     node run_all.js --require-version=cet6-v36    # 版本不符则 exit 4，产物不冒充该版本

   产物：docs/run-all-result.json —— 含 meta.version / meta.hashes / meta.gitHead，
        让"一份回归证据"绑定当时被测的代码版本；发布前用 --require-version 校验。
   ============================================================================ */
require('./_io_patch'); // 预加载 writeFileSync 重试补丁（本机 Windows 文件锁）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
/* 注意：**不要用 spawnSync**。本机环境下 spawnSync 一律以 EBUSY 立即失败
   （与 timeout/cwd/encoding/maxBuffer 参数无关，异步 spawn 正常），
   会让全部用例被误判为 CRASH。故统一走异步 spawn + Promise。 */

const SCRIPTS = __dirname;
const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const METRICS = path.join(DOCS, 'metrics');
const BASELINE_FILE = path.join(METRICS, 'baseline.json');

/* ------------------------------ 动态断言基线（B4） ------------------------------
   旧版 min 是写死的常数，远低于实测值（test_core min=20 vs 实测 262 → 容忍 92% 蒸发）。
   现改为：min = max(写死下限, 基线×0.9)。基线存 docs/metrics/baseline.json，
   每次全绿运行回写实测值，让"删掉断言"真的能被拦住（容忍度降到 10% 以内）。 */
let BASELINE = {};
try { BASELINE = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (e) { BASELINE = {}; }
function minFor(t) {
  const base = Number(BASELINE[t.f]) || 0;
  if (base > 0) return Math.max(t.min, Math.floor(base * 0.9));
  return t.min;
}

/* ---------------------------------------------------------------------------
   清单：只收用例，不收生成器/补丁工具（gen_* / fix_* / *_patch_* / *.py）。
   min = 该脚本的历史断言数下限（实测值向下留余量），低于它视为"套件缩水"。
   --------------------------------------------------------------------------- */
const TESTS = [
  /* --- Node 侧：纯逻辑，快 --- */
  { f: 'test_core.js', g: 'core', min: 20, d: 'core.js 纯函数单测' },
  { f: 'test_journey_logic.js', g: 'core', min: 20, d: '主流程逻辑（memStore+vm，非浏览器）' },
  { f: 'retest_core.js', g: 'core', min: 5, d: '复测轮 · core 边界' },
  { f: 'retest_shape.js', g: 'core', min: 0, kind: 'dump', d: '题库字段形状导出（工具型，无断言）' },
  { f: 'verify_bank.js', g: 'core', min: 5, d: '题库完整性校验' },
  { f: 'verify_fixes.js', g: 'core', min: 5, d: '历史修复回归校验' },
  { f: 'test_bank_contract.js', g: 'core', min: 20, d: '题库字段契约（逐卷逐题）' },
  { f: 'test_version_sync.js', g: 'core', min: 3, d: '三方版本号一致性' },
  { f: 'check_divergence.js', g: 'core', min: 20, d: '双项目防漏修：共享内核字节一致 + 修复点清单' },
  { f: 'test_contrast_light.js', g: 'core', min: 3, d: '浅色主题对比度 ≥4.5:1' },
  { f: 'test_mutation.js', g: 'core', min: 12, d: '变异测试：15 个变异体必须全被杀（存活即断言不足）' },
  { f: 'test_coverage.js', g: 'core', min: 2, d: 'core.js 覆盖率门禁（行/分支 ≥80%，排除 bank）' },
  { f: 'test_id_isolation.js', g: 'core', min: 3, d: '4 位学习编号隔离风险声明 + 存储键隔离' },
  { f: 'test_sync.js', g: 'core', min: 30, d: '私有同步（共享内核）：合并算法 + 端点并发/恢复闭环' },

  /* --- 浏览器：功能与交互 --- */
  { f: 'test_e2e_ui.js', g: 'browser', min: 30, d: '真实 E2E（Playwright 驱动 UI：登录→做题→错题→统计→备份→导出导入）' },
  { f: 'test_mobile.js', g: 'browser', min: 6, d: '移动端模拟（375/390/414 视口做题链路；真机仍未实测）' },
  { f: 'test_a11y.js', g: 'browser', min: 3, d: '无障碍取证：34 个交互控件访问名/alt/landmark/键盘可达' },
  { f: 'test_ui.js', g: 'browser', min: 8, d: 'UI 结构与选择流程' },
  { f: 'test_p3.js', g: 'browser', min: 8, d: 'P3 轮修复点' },
  { f: 'test_p4.js', g: 'browser', min: 8, d: 'P4 轮修复点' },
  { f: 'test_p72.js', g: 'browser', min: 8, d: 'P7-2 修复点' },
  { f: 'test_p73.js', g: 'browser', min: 8, d: 'P7-3 修复点' },
  { f: 'test_p7fix.js', g: 'browser', min: 6, d: 'P7 修复点汇总' },
  { f: 'test_cloze.js', g: 'browser', min: 5, d: '选词填空' },
  { f: 'test_lazy.js', g: 'browser', min: 8, d: '按需加载（架构级）' },
  { f: 'test_listening_player.js', g: 'browser', min: 8, d: '听力播放器' },
  { f: 'test_timer.js', g: 'browser', min: 8, d: '计时器/限时' },
  { f: 'test_student_journey.js', g: 'browser', min: 9, d: '学生完整旅程' },
  { f: 'test_perf_audit.js', g: 'browser', min: 10, d: '性能审计' },
  { f: 'test_release_audit.js', g: 'browser', min: 10, d: '发布前审计' },
  // 注意：这个套件是"聚合判定"，多数断言本身就是一整类检查的结论（脏数据/导出/边界/完整旅程），
  // 真实产出 12 条。旧的 min=20 是历史遗留的虚高值，会让它永远被判 SHRUNK。
  { f: 'test_security_audit.js', g: 'browser', min: 12, timeout: 900000, d: '安全与健壮性审计' },
  { f: 'verify_fix_report.js', g: 'browser', min: 1, d: '修复报告自检（依赖 security_audit 产物）' },
  { f: 'test_security_extra.js', g: 'browser', min: 8, d: '安全补充用例' },
  { f: 'test_retest_interaction.js', g: 'browser', min: 30, d: '复测轮 · 交互状态机' },
  { f: 'test_round3_interaction.js', g: 'browser', min: 150, d: '第三轮 · 交互回归' },
  // 2026-11-12：线上写译卡缺陷的本地可复现回归（本机临时 HTTP 服务器，
  // 覆盖 <script src> 挂死 → fetch 通道修复；不依赖公网）
  { f: 'test_paper_load_http.js', g: 'browser', min: 8, d: 'HTTP 按需加载大卷（线上缺陷回归）' },
  // 桌面 WebKit + iPhone 视口。引擎缺失判 FAIL（不静默跳过），但结论按「部分证据」记
  { f: 'test_webkit.js', g: 'browser', min: 10, d: 'WebKit 引擎 + iPhone 视口（非 iOS 真机）' },

  /* --- 网络/离线/兼容：依赖外部条件，失败注明为条件性 ---
     例外：线上版本一致性单独拆成 test_deploy_version.js 且**不带 opt**。
     「部署滞后」是交付事故（曾长期线上 v32 / 本地 v33 却 GATE PASS），
     不能和"网络冒烟偶尔不通"一起被条件性豁免吞掉。 */
  { f: 'test_deploy_version.js', g: 'net', min: 1, d: '线上版本一致性（必过，防部署滞后）' },
  // 只查版本号挡不住「version.js 更新了、index.html/core.js/题库仍是旧的」，
  // 故加一道逐字节内容比对，含 app HEAD 树核对与 404 页面识别
  { f: 'verify_deploy.js', g: 'net', min: 30, d: '线上文件内容逐字节一致（必过，防半吊子部署）' },
  { f: 'test_online.js', g: 'net', min: 1, d: '在线冒烟（登录→清单→进组→判分→版本比对）', opt: 1 },
  { f: 'test_offline_https.js', g: 'net', min: 1, d: 'HTTPS/离线' },
  { f: 'test_offline_perf.js', g: 'net', min: 1, d: '离线性能' },
  { f: 'test_firefox_playwright.js', g: 'net', min: 1, d: 'Firefox 兼容', opt: 1 },

  /* --- 复测轮遗留探针（多为"取证型"脚本，断言少） --- */
  { f: 'retest_xss.js', g: 'probe', min: 1, d: 'XSS 取证' },
  { f: 'retest_csp.js', g: 'probe', min: 1, d: 'CSP 取证' },
  { f: 'retest_import.js', g: 'probe', min: 1, d: '导入取证' },
  { f: 'retest_storage.js', g: 'probe', min: 1, d: '存储取证' },
  { f: 'retest_pwa.js', g: 'probe', min: 1, d: 'PWA 取证' },
  // 只读定位探针：设计上就是把结果打印出来，本身不做判定（和 retest_shape.js 同一类）。
  // 判它 NO-ASSERT 属于冤枉 —— 它的价值是"跑起来并给出取证输出"。
  { f: 'retest_pwa_probe.js', g: 'probe', min: 0, kind: 'dump', d: 'PWA 单点定位探针（只读取证，无断言）' },
  { f: 'retest_journey.js', g: 'probe', min: 1, d: '旅程取证' },
  { f: 'retest_misc.js', g: 'probe', min: 1, d: '杂项取证' },
  // 取证型探针：只输出取证信息（下载/JSON 头部/控制台），本身不做 ok/fail 判定。
  // 与 retest_shape.js / retest_pwa_probe.js 同类，判 NO-ASSERT 属于冤枉。
  { f: 'retest_probe.js', g: 'probe', min: 0, kind: 'dump', d: '通用探针（只读取证，无断言）' },
  { f: 'retest_reach.js', g: 'probe', min: 1, d: '可达性取证' },
  /* 2026-11-17 真实压测（取证型，必过）：
     同步服务压测只打 127.0.0.1 临时端口、数据落 os.tmpdir()、跑完即删，不碰生产；
     前端压测用本机临时 HTTP 服务的 app 副本，数据是合法日期 + 真实题号。
     CI 只跑 core 组，不受这两项影响；本地全量回归会连它们一起跑并留档。 */
  { f: 'test_stress_sync.js', g: 'probe', min: 12, d: '同步服务并发压测（本地实例 600+ 请求）' },
  { f: 'test_stress_frontend.js', g: 'probe', min: 9, d: '前端大数据压测（700 天 / 3000 题）' },
];

/* ------------------------------ 参数解析 ------------------------------ */
const argv = process.argv.slice(2);
const argOf = k => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : null; };
const GROUP = argOf('group') || 'all';
const ONLY = argOf('only');
/* --skip=a.js,b.js：CI 等"只有两个仓"的环境里，显式排除依赖完整多仓布局的用例。
   被跳过的用例压根不进 picked，因此不参与汇总、也不写 baseline——
   「没跑」不会被记成「通过」。结果 JSON 里会留下 skipped 清单便于复核。 */
const SKIP = new Set((argOf('skip') || '').split(',').map(s => s.trim()).filter(Boolean));
const TIMEOUT = Number(argOf('timeout') || 480000);
const LIST_ONLY = argv.includes('--list');

/* ------------------------------ 发布证据绑定 ------------------------------
   结果 JSON 必须能回答"这是哪个版本、哪份代码跑出来的"。
   无 git 也能跑：gitHead 记 null，version/hashes 仍绑定，不因环境缺 git 就假绿。 */
const REQUIRE_VERSION = argOf('require-version');
function gitHeadOf(dir) {
  try {
    const out = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return String(out).trim() || null;
  } catch (e) { return null; }
}
function readVersion() {
  try {
    const s = fs.readFileSync(path.join(ROOT, 'app', 'version.js'), 'utf8');
    const m = /(?:CET4|CET6)_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(s);
    return m ? m[1] : null;
  } catch (e) { return null; }
}
function fileHash(rel) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
  } catch (e) { return null; }
}
const FINGERPRINT_FILES = [
  'app/version.js', 'app/index.html', 'app/core.js', 'app/sw.js',
  'app/sync.js', 'app/sync-config.js', 'scripts/sync-server.js',
  'scripts/run_all.js', 'scripts/check_divergence.js'
];
function collectMeta() {
  const hashes = {};
  FINGERPRINT_FILES.forEach(function (rel) { hashes[rel] = fileHash(rel); });
  return {
    version: readVersion(),
    hashes: hashes,
    gitHead: {
      root: gitHeadOf(ROOT),
      app: gitHeadOf(path.join(ROOT, 'app')),
      scripts: gitHeadOf(path.join(SCRIPTS)),
    },
    capturedAt: new Date().toISOString(),
  };
}
const META = collectMeta();

// 版本不符：exit 4，并在写 JSON 之前就挡住，避免产物冒充目标版本。
if (REQUIRE_VERSION && META.version !== REQUIRE_VERSION) {
  console.error('版本不符：当前 app/version.js = ' + (META.version || '(读取失败)') +
    '，要求 --require-version=' + REQUIRE_VERSION + '。拒绝运行并拒绝写产物。');
  process.exit(4);
}

const picked = TESTS.filter(t => {
  if (GROUP !== 'all' && t.g !== GROUP) return false;
  if (ONLY && t.f.indexOf(ONLY) < 0) return false;
  if (SKIP.has(t.f)) return false;
  return fs.existsSync(path.join(SCRIPTS, t.f));
});
const SKIPPED = TESTS.filter(t => SKIP.has(t.f)).map(t => t.f);

if (LIST_ONLY) {
  console.log('共 ' + picked.length + ' 个用例：');
  picked.forEach(t => console.log('  [' + t.g + '] ' + t.f + '  min=' + t.min + '  ' + t.d + (t.opt ? '  (条件性)' : '')));
  process.exit(0);
}
if (!picked.length) { console.error('没有匹配到任何用例（group=' + GROUP + ' only=' + (ONLY || '-') + '）'); process.exit(2); }

/* ------------------------------ 断言解析 ------------------------------
   仓库里并存四种约定，全部兼容：
     ok - <name>   /  ok   <name>   /  PASS <name>        （主流：chk/assert 助手）
     [PASS] 组 · 名  /  [FAIL] 组 · 名                     （retest_core.js 的 t() 助手）
     ✅ <名> / ❌ <名>                                      （verify_fix_report.js）
     结尾汇总行：N ok / M fail
   取"行计数"与"汇总值"的较大者，避免漏算。
   注意 [fact] / [dump] 之类的中性行不会被计入——它们不代表判定。                     */
// 注意 \b 只能挂在单词型标记（ok/pass/fail/error）后面：✅ ✓ √ 是非单词字符，
// 后面跟空格时不存在单词边界，写成 (?:ok|pass|√|✓|✅)\b 会永远匹配不上 ✅ 那一路。
const RE_OK = /^\s*\[?\s*(?:(?:ok|pass)\b|√|✓|✅)/i;
const RE_NO = /^\s*\[?\s*(?:(?:fail|failed|error)\b|✗|×|❌)/i;
const RE_SUM = /(\d+)\s*ok\s*\/\s*(\d+)\s*fail/gi;

/* 聚合类脚本（test_coverage.js）会把子进程的汇总行原样回显成
   "xxx.js exit: 0 | tail: ===== ... 20273 ok / 0 fail ====="。
   那是**别人的成绩**，不是本脚本的断言；不过滤就会被 RE_SUM 重复计一遍
   （历史事故：42001 条断言里 20273 条是重复计数，且被写进了 baseline）。 */
const RE_ECHO = /^\s*[\w.-]+\.js\s+exit:.*\|\s*tail:/i;

function parse(out) {
  let ok = 0, fail = 0;
  const lines = out.split(/\r?\n/).filter(l => !RE_ECHO.test(l));
  lines.forEach(l => {
    if (RE_OK.test(l)) ok++;
    else if (RE_NO.test(l)) fail++;
  });
  const clean = lines.join('\n');
  let m, sOk = 0, sFail = 0;
  RE_SUM.lastIndex = 0; // 全局正则，显式复位避免跨用例残留 lastIndex
  while ((m = RE_SUM.exec(clean))) { sOk = Math.max(sOk, +m[1]); sFail = Math.max(sFail, +m[2]); }
  if (sOk > ok) ok = sOk;
  if (sFail > fail) fail = sFail;
  return { ok, fail };
}

/* ------------------------------ 执行（异步 spawn） ------------------------------ */
function runOne(t) {
  return new Promise(resolve => {
    const i0 = Date.now();
    const child = spawn(process.execPath, ['--require', path.join(SCRIPTS, '_io_patch.js'), t.f], {
      cwd: SCRIPTS,
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', done = false, timedOut = false;
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const kill = () => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) { }
      // Windows：用例本身会再拉起浏览器，是"孙子进程"，必须整棵树结束，否则残留进程会拖慢后续用例
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { }
      }
    };
    // 单个用例可自带超时（t.timeout），缺省用全局 TIMEOUT。
    // 注意 test_security_audit 实测跑到 448s，而全局上限是 480s —— 余量只有 7%，
    // 机器稍慢一点就会被误判 TIMEOUT。它跑的是 20 组 XSS + 18 组脏数据，本来就慢，
    // 所以给它单独放宽，而不是把全局上限一起抬高（那样会掩盖真正卡死的用例）。
    const timer = setTimeout(kill, Number(t.timeout || TIMEOUT));
    const finish = (code, spawnErr) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ code, spawnErr, out, ms: Date.now() - i0, timedOut });
    };
    child.on('error', e => finish(null, e));
    child.on('close', c => finish(c, null));
  });
}

(async function main() {
  const rows = [];
  const t00 = Date.now();
  console.log('===== run_all（' + picked.length + ' 个用例 · 串行 · 单例超时 ' + (TIMEOUT / 1000) + 's）=====\n');

  for (let i = 0; i < picked.length; i++) {
    const t = picked[i];
    process.stdout.write('[' + (i + 1) + '/' + picked.length + '] ' + t.f + ' ... ');
    const r = await runOne(t);
    const { ok, fail } = parse(r.out);
    const total = ok + fail;

    const effMin = minFor(t);
    // 环境跳过：用例自己显式打印 ENV-SKIP（如线上站点未部署、浏览器构建缺失）。
    // 记为 SKIP：不算通过、不算假绿、不算必过失败，总计单列原因。
    const envSkip = /ENV-SKIP[:：]/.test(r.out);
    let verdict;
    if (r.timedOut) verdict = 'TIMEOUT';
    else if (r.code === null) verdict = 'CRASH';
    else if (envSkip) verdict = 'SKIP';
    else if (t.kind === 'dump') {
      verdict = (r.code === 0 && r.out.trim().length >= 200) ? 'DUMP-OK' : 'DUMP-FAIL';
    }
    else if (total === 0) verdict = 'NO-ASSERT';
    else if (fail > 0) verdict = 'FAIL';
    else if (total < effMin) verdict = 'SHRUNK';
    else if (r.code !== 0) verdict = 'EXIT' + r.code;
    else verdict = 'PASS';

    const pass = verdict === 'PASS' || verdict === 'DUMP-OK';
    rows.push({
      file: t.f, group: t.g, desc: t.d, optional: !!t.opt,
      verdict: verdict, pass: pass,
      reason: verdict === 'SKIP' ? (r.out.split(/\r?\n/).find(l => /ENV-SKIP[:：]/.test(l)) || '').trim() : undefined,
      exit: r.code, ms: r.ms, ok, fail, total, min: effMin,
      tail: r.out.split(/\r?\n/).filter(l => l.trim()).slice(-8).join(' ⏎ ').slice(0, 800),
    });
    console.log(verdict + '  (' + ok + ' ok / ' + fail + ' fail · ' + (r.ms / 1000).toFixed(1) + 's)');
    if (!pass) { // 未通过时当场回显末尾输出，免得再去翻日志
      r.out.split(/\r?\n/).filter(l => l.trim()).slice(-4).forEach(l => console.log('        │ ' + l.slice(0, 220)));
    }
  }

  /* ------------------------------ 汇总 ------------------------------ */
  const byG = {};
  rows.forEach(r => { (byG[r.group] = byG[r.group] || []).push(r); });
  console.log('\n================= 分区结果 =================');
  Object.keys(byG).forEach(g => {
    const rs = byG[g];
    const p = rs.filter(r => r.pass).length;
    console.log('  ' + g.padEnd(8) + ' ' + p + '/' + rs.length + ' 通过   ' +
      rs.filter(r => !r.pass).map(r => r.file.replace(/\.js$/, '') + '(' + r.verdict + ')').join(' '));
  });

  const totalAssert = rows.reduce((a, r) => a + r.total, 0);
  const totalOk = rows.reduce((a, r) => a + r.ok, 0);
  const totalFail = rows.reduce((a, r) => a + r.fail, 0);
  const hard = rows.filter(r => !r.pass && !r.optional && r.verdict !== 'SKIP');
  const skippedEnv = rows.filter(r => r.verdict === 'SKIP');
  // B4：假绿/缩水判定排除 optional 用例（在线/离线条件性用例失败不应污染假绿计数）
  const fake = rows.filter(r => !r.optional && (r.verdict === 'NO-ASSERT' || r.verdict === 'SHRUNK'));
  const passed = rows.filter(r => r.pass).length;

  console.log('\n================= 总计 =================');
  console.log('  用例 ' + rows.length + ' 个：' + passed + ' 通过 / ' + (rows.length - passed - skippedEnv.length) + ' 未通过 / ' + skippedEnv.length + ' 环境跳过');
  if (skippedEnv.length) skippedEnv.forEach(r => console.log('    环境跳过: ' + r.file + ' — ' + String(r.reason || '').slice(0, 120)));
  console.log('  断言 ' + totalAssert + ' 条：' + totalOk + ' ok / ' + totalFail + ' fail');
  console.log('  假绿/缩水（0 断言或低于下限却"通过"）' + fake.length + ' 个' + (fake.length ? ' → ' + fake.map(r => r.file + '(' + r.verdict + ')').join(', ') : ''));
  console.log('  必过项未通过 ' + hard.length + ' 个' + (hard.length ? ' → ' + hard.map(r => r.file + '(' + r.verdict + ')').join(', ') : ''));
  console.log('  总耗时 ' + ((Date.now() - t00) / 1000).toFixed(1) + 's');

  try {
    fs.writeFileSync(path.join(DOCS, 'run-all-result.json'), JSON.stringify({
      ts: new Date().toISOString(), group: GROUP, only: ONLY || null, skipped: SKIPPED, timeoutMs: TIMEOUT,
      meta: META,
      totals: {
        cases: rows.length, pass: passed, assertions: totalAssert, ok: totalOk, fail: totalFail,
        fakeGreen: fake.length, hardFailed: hard.length, envSkipped: skippedEnv.length,
      },
      rows,
    }, null, 2), 'utf8');
    console.log('  JSON -> docs/run-all-result.json');
  } catch (e) { console.log('  (写 JSON 失败: ' + e.message + ')'); }

  /* 硬闸门：必过项失败 / 假绿缩水 / 断言总数为 0 → 非零退出 */
  const gate = [];
  if (totalAssert === 0) gate.push('全部用例合计 0 条断言（整体假绿）');
  if (fake.length) gate.push(fake.length + ' 个用例 0 断言或低于下限却"通过"');
  if (hard.length) gate.push(hard.length + ' 个必过用例未通过');
  if (gate.length) { console.log('\nGATE FAIL: ' + gate.join('；')); process.exit(1); }

  /* B4：全绿运行 → 回写动态基线（用实测值刷新，下次容忍度 = 10%） */
  try {
    rows.forEach(r => { if (r.total > 0) BASELINE[r.file] = r.total; });
    BASELINE._updated = new Date().toISOString();
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(BASELINE, null, 2), 'utf8');
  } catch (e) { console.log('  (基线回写失败: ' + e.message + ')'); }

  console.log('\nGATE PASS: 全部必过用例通过，且无假绿');
  process.exit(0);
})();
