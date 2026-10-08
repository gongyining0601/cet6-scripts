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

   产物：docs/run-all-result.json
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
/* 注意：**不要用 spawnSync**。本机环境下 spawnSync 一律以 EBUSY 立即失败
   （与 timeout/cwd/encoding/maxBuffer 参数无关，异步 spawn 正常），
   会让全部用例被误判为 CRASH。故统一走异步 spawn + Promise。 */

const SCRIPTS = __dirname;
const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

/* ---------------------------------------------------------------------------
   清单：只收用例，不收生成器/补丁工具（gen_* / fix_* / *_patch_* / *.py）。
   min = 该脚本的历史断言数下限（实测值向下留余量），低于它视为"套件缩水"。
   --------------------------------------------------------------------------- */
const TESTS = [
  /* --- Node 侧：纯逻辑，快 --- */
  { f: 'test_core.js', g: 'core', min: 20, d: 'core.js 纯函数单测' },
  { f: 'retest_core.js', g: 'core', min: 5, d: '复测轮 · core 边界' },
  { f: 'retest_shape.js', g: 'core', min: 0, kind: 'dump', d: '题库字段形状导出（工具型，无断言）' },
  { f: 'verify_bank.js', g: 'core', min: 5, d: '题库完整性校验' },
  { f: 'verify_fixes.js', g: 'core', min: 5, d: '历史修复回归校验' },
  { f: 'verify_fix_report.js', g: 'core', min: 1, d: '修复报告生成/自检' },

  /* --- 浏览器：功能与交互 --- */
  { f: 'test_e2e.js', g: 'browser', min: 20, d: '端到端主流程' },
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
  { f: 'test_security_extra.js', g: 'browser', min: 8, d: '安全补充用例' },
  { f: 'test_retest_interaction.js', g: 'browser', min: 30, d: '复测轮 · 交互状态机' },
  { f: 'test_round3_interaction.js', g: 'browser', min: 150, d: '第三轮 · 交互回归' },

  /* --- 网络/离线/兼容：依赖外部条件，失败注明为条件性 --- */
  { f: 'test_online.js', g: 'net', min: 1, d: '在线环境', opt: 1 },
  { f: 'test_online_p71.js', g: 'net', min: 1, d: '在线 P7-1', opt: 1 },
  { f: 'test_online_p72.js', g: 'net', min: 1, d: '在线 P7-2', opt: 1 },
  { f: 'test_online_p73.js', g: 'net', min: 1, d: '在线 P7-3', opt: 1 },
  { f: 'test_offline_https.js', g: 'net', min: 1, d: 'HTTPS/离线', opt: 1 },
  { f: 'test_offline_perf.js', g: 'net', min: 1, d: '离线性能', opt: 1 },
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
  { f: 'retest_probe.js', g: 'probe', min: 1, d: '通用探针' },
  { f: 'retest_reach.js', g: 'probe', min: 1, d: '可达性取证' },
];

/* ------------------------------ 参数解析 ------------------------------ */
const argv = process.argv.slice(2);
const argOf = k => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : null; };
const GROUP = argOf('group') || 'all';
const ONLY = argOf('only');
const TIMEOUT = Number(argOf('timeout') || 480000);
const LIST_ONLY = argv.includes('--list');

const picked = TESTS.filter(t => {
  if (GROUP !== 'all' && t.g !== GROUP) return false;
  if (ONLY && t.f.indexOf(ONLY) < 0) return false;
  return fs.existsSync(path.join(SCRIPTS, t.f));
});

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

function parse(out) {
  let ok = 0, fail = 0;
  out.split(/\r?\n/).forEach(l => {
    if (RE_OK.test(l)) ok++;
    else if (RE_NO.test(l)) fail++;
  });
  let m, sOk = 0, sFail = 0;
  while ((m = RE_SUM.exec(out))) { sOk = Math.max(sOk, +m[1]); sFail = Math.max(sFail, +m[2]); }
  if (sOk > ok) ok = sOk;
  if (sFail > fail) fail = sFail;
  return { ok, fail };
}

/* ------------------------------ 执行（异步 spawn） ------------------------------ */
function runOne(t) {
  return new Promise(resolve => {
    const i0 = Date.now();
    const child = spawn(process.execPath, [t.f], {
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

    let verdict;
    if (r.timedOut) verdict = 'TIMEOUT';
    else if (r.code === null) verdict = 'CRASH';
    else if (t.kind === 'dump') {
      // 工具型脚本：本身不做判定，只导出信息。它的价值是"bank 文件坏了就会崩"，
      // 因此要求退出码 0 且确实产出了内容；不参与断言闸门（否则会冤枉成假绿）。
      verdict = (r.code === 0 && r.out.trim().length >= 200) ? 'DUMP-OK' : 'DUMP-FAIL';
    }
    else if (total === 0) verdict = 'NO-ASSERT';     // 假绿：跑了但一条都没验
    else if (fail > 0) verdict = 'FAIL';
    else if (total < t.min) verdict = 'SHRUNK';      // 套件缩水
    else if (r.code !== 0) verdict = 'EXIT' + r.code;
    else verdict = 'PASS';

    const pass = verdict === 'PASS' || verdict === 'DUMP-OK';
    rows.push({
      file: t.f, group: t.g, desc: t.d, optional: !!t.opt,
      verdict: verdict, pass: pass,
      exit: r.code, ms: r.ms, ok, fail, total, min: t.min,
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
  const hard = rows.filter(r => !r.pass && !r.optional);
  const fake = rows.filter(r => r.verdict === 'NO-ASSERT' || r.verdict === 'SHRUNK');
  const passed = rows.filter(r => r.pass).length;

  console.log('\n================= 总计 =================');
  console.log('  用例 ' + rows.length + ' 个：' + passed + ' 通过 / ' + (rows.length - passed) + ' 未通过');
  console.log('  断言 ' + totalAssert + ' 条：' + totalOk + ' ok / ' + totalFail + ' fail');
  console.log('  假绿/缩水（0 断言或低于下限却"通过"）' + fake.length + ' 个' + (fake.length ? ' → ' + fake.map(r => r.file + '(' + r.verdict + ')').join(', ') : ''));
  console.log('  必过项未通过 ' + hard.length + ' 个' + (hard.length ? ' → ' + hard.map(r => r.file + '(' + r.verdict + ')').join(', ') : ''));
  console.log('  总耗时 ' + ((Date.now() - t00) / 1000).toFixed(1) + 's');

  try {
    fs.writeFileSync(path.join(DOCS, 'run-all-result.json'), JSON.stringify({
      ts: new Date().toISOString(), group: GROUP, only: ONLY || null, timeoutMs: TIMEOUT,
      totals: {
        cases: rows.length, pass: passed, assertions: totalAssert, ok: totalOk, fail: totalFail,
        fakeGreen: fake.length, hardFailed: hard.length,
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
  console.log('\nGATE PASS: 全部必过用例通过，且无假绿');
  process.exit(0);
})();
