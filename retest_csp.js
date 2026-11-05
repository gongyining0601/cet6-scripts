'use strict';
/* ============================================================================
   CET6 复测轮 C 补测：CSP（内容安全策略）评估 —— 实测而非纸面
     基线      ：无 CSP（现状）
     CSP-A     ：script-src 'self' 'unsafe-inline'（最容易落地）
     CSP-B     ：script-src 'self'（最严，无 inline 白名单）——预期内联脚本被拦、应用失效
     CSP-C     ：script-src 'self' 'sha256-<两个内联块>'（严且可用）
   全部在 HTTPS 副本上做（不改 D:\CET6\app 源文件）；header 形式的 CSP 只对 http(s) 生效。
   运行：cd D:\CET6\scripts ; node retest_csp.js
   产物：docs/retest-security-csp-*.png / docs/retest-csp-result.json / docs/retest-csp-log.txt
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { chromium: loadChromium, EXE, answerAllInQuiz } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const DOCS = path.join(ROOT, 'docs');
const CERTS = path.join(__dirname, 'certs');
/* 2026-11-05 修：这里原来写死的是上一台机器的绝对路径
   （C:\Users\...\Doubao\...\scratch\csp-fixture）。换机器后该目录不存在，
   开头的 fs.rmSync 直接抛 EPERM/ENOENT —— 整个用例 0.8 秒就 FATAL 退出，
   "CSP 实测"从未真正跑过。改为按脚本位置落一个每次运行唯一的临时目录。 */
/* 2026-11-05 再修：原来用 `csp-fixture-<时间戳>` 一次性目录，收尾 rmSync 要删 90 个文件，
   直接撞上本机安全删除护栏（BULK_CONFIRM_REQUIRED，阈值 50）——整个用例以 exit 2 收场。
   改为**固定目录 + 覆盖式拷贝**：不删目录、不删文件，每次用 copyFileSync 覆盖同名文件即可，
   残留风险只是旧版本多出来的文件（app/ 文件集合稳定），且 .scratch/ 已在 .gitignore 里。 */
const SCRATCH_ROOT = path.join(__dirname, '.scratch');
const SCRATCH = path.join(SCRATCH_ROOT, 'csp-fixture');

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const R = { meta: {}, inlineScripts: [], variants: [], summary: {} };
function t(name, group, pass, detail) { R.variants.push({ check: name, group, pass: !!pass, detail }); log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`); return pass; }
async function shot(page, n) { try { await page.screenshot({ path: path.join(DOCS, 'retest-security-csp-' + n + '.png') }); } catch (e) { } }

const STYLE_OK = "style-src 'self' 'unsafe-inline'";     // 页面大量使用 style="..." 属性，必须放行
function variants(hashes) {
  const common = "default-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
    "frame-src https://english-exam.lazynote.cn; object-src 'none'; base-uri 'none'; form-action 'none';";
  return [
    { id: 'baseline', csp: null },
    { id: 'A-unsafe-inline', csp: `script-src 'self' 'unsafe-inline'; ${STYLE_OK}; ${common}` },
    { id: 'B-strict-no-inline', csp: `script-src 'self'; ${STYLE_OK}; ${common}` },
    { id: 'C-strict-with-hash', csp: `script-src 'self' ${hashes.map(h => `'${h}'`).join(' ')}; ${STYLE_OK}; ${common}` },
  ];
}
function startServer(dir, port, csp) {
  return new Promise((resolve, reject) => {
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
    const srv = https.createServer({ key: fs.readFileSync(path.join(CERTS, 'key.pem')), cert: fs.readFileSync(path.join(CERTS, 'cert.pem')) }, (req, res) => {
      let u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/' || u === '') u = '/index.html';
      const fp = path.join(dir, u);
      if (!fp.startsWith(dir)) { res.writeHead(403); return res.end('no'); }
      fs.readFile(fp, (e, buf) => {
        if (e) { res.writeHead(404); return res.end('404'); }
        const h = { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' };
        if (csp && path.extname(fp) === '.html') h['Content-Security-Policy'] = csp;
        res.writeHead(200, h); res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  let srv = null;
  try {
    R.meta = { browser: EXE, node: process.version, startedAt: new Date().toISOString(), app: APP };
    log('CET6 复测 C · CSP 实测  ' + R.meta.startedAt + '\n');

    /* 1) 现状：是否存在 CSP */
    const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
    const metaCsp = html.match(/<meta[^>]+http-equiv=["']?Content-Security-Policy/i);
    const inlineBlocks = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)).map(m => m[1]);
    R.inlineScripts = inlineBlocks.map((s, i) => ({ index: i, chars: s.length, sha256: 'sha256-' + crypto.createHash('sha256').update(s, 'utf8').digest('base64') }));
    log('无 CSP 现状：' + JSON.stringify({ headerCSP: '（生产为 file:// 无响应头）', metaCSP: !!metaCsp }));
    log('内联 <script> 块数量 = ' + inlineBlocks.length + '；hash：');
    R.inlineScripts.forEach(x => log('   #' + x.index + ' ' + x.chars + ' chars  ' + x.sha256));
    t('index.html 已配置 CSP（meta http-equiv 形式）', 'CSP 现状', !!metaCsp, 'metaCSP=' + String(!!metaCsp));
    if (metaCsp) {
      const policy = (html.match(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*content="([^"]*)"/i) || [])[1] || '';
      R.metaCspPolicy = policy;
      log('   当前策略：' + policy);
      const has = re => re.test(policy);
      t('现状 CSP 含 script-src 指令', 'CSP 现状', has(/script-src/), policy.match(/script-src[^;]*/)?.[0]);
      t('现状 CSP 关闭 object-src（插不进插件/Flash 类攻击面）', 'CSP 现状', has(/object-src\s+'none'/), (policy.match(/object-src[^;]*/) || [])[0]);
      t('现状 CSP 固定 base-uri（防 <base> 劫持）', 'CSP 现状', has(/base-uri\s+'none'/), (policy.match(/base-uri[^;]*/) || [])[0]);
      t('现状 CSP 未使用 unsafe-eval（无 eval 执行面）', 'CSP 现状', !has(/'unsafe-eval'/), has(/'unsafe-eval'/) ? '含 unsafe-eval' : '不含');
      if (has(/script-src[^;]*'unsafe-inline'/)) log('   注：script-src 目前含 unsafe-inline（内联脚本未 hash 化），下面用 A/C 两档实测可收紧到什么程度。');
    }
    t('内联脚本块可被 sha256 白名单化（数量=' + inlineBlocks.length + '）', 'CSP 现状', inlineBlocks.length > 0, JSON.stringify(R.inlineScripts.map(x => x.sha256)));

    /* 2) 副本 + 各变体实测 */
    // 每次运行用新目录，避免"先整体删除旧目录"（大量删除在部分环境会被拦截）
    fs.mkdirSync(path.join(SCRATCH, 'bank'), { recursive: true });
    for (const f of fs.readdirSync(APP)) { const s = path.join(APP, f); if (!fs.statSync(s).isDirectory()) fs.copyFileSync(s, path.join(SCRATCH, f)); }
    for (const f of fs.readdirSync(path.join(APP, 'bank'))) { const s = path.join(APP, 'bank', f); if (fs.statSync(s).isDirectory()) continue; fs.copyFileSync(s, path.join(SCRATCH, 'bank', f)); }   // bank/json 子目录是原始 JSON 大文件，应用不请求，跳过

    const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    let port = 9550;
    for (const v of variants(R.inlineScripts.map(x => x.sha256))) {
      port++;
      srv = await startServer(SCRATCH, port, v.csp);
      const ctx = await browser.newContext({ viewport: { width: 430, height: 940 }, ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      const violations = [], pe = [];
      page.on('console', m => { const x = m.text(); if (/Content Security Policy|CSP|Refused to/i.test(x)) violations.push({ type: m.type(), text: x.slice(0, 180) }); });
      page.on('pageerror', e => pe.push(String(e.message || e).slice(0, 200)));
      const U = `https://127.0.0.1:${port}/index.html`;
      let r = { id: v.id, csp: v.csp, violations: violations.length, pageErrors: pe.length, banks: 0, loginOk: false, groupOk: false, judged: false, exportOk: false, sample: violations.slice(0, 3) };
      try {
        await page.goto(U, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(1800);
        r.banks = await page.evaluate(() => (window.CET6_BANKS || []).length);
        r.coreLoaded = await page.evaluate(() => !!(window.CET6Core));
        if (await page.locator('#loginMask').count() && await page.locator('#loginMask').isVisible()) {
          await page.locator('#phoneInput').fill('9203');
          await page.locator('#loginBtn').click();
          await page.waitForTimeout(1200);
        }
        r.loginOk = await page.evaluate(() => !document.getElementById('loginMask') && document.querySelectorAll('#planList .card').length > 0);   // 登录成功后 location.reload()，mask 不再存在
        await page.waitForTimeout(500);
        const btn = page.locator('#planList .card button').first();
        if (await btn.count()) {
          await btn.click();
          /* 按需加载时代：题目脚本是异步注入的，点开卡片后 #quizBody 里还没有 .opt。
             旧写法等 600ms 就找题 → qids 为空 → #groupSubmit 始终 disabled →
             click() 卡满 30s 超时，三个变体全部 FATAL。改为等题面真正挂载。 */
          /* 清单首张卡常常是「选词填空」组（只有 .cloze-slot，没有 .opt），
             旧写法按 .opt 收集 qid → 拿到 0 题 → #groupSubmit 永远 disabled。
             改用共享的 answerAllInQuiz：客观题点选项、选词填空配对，两类都覆盖。 */
          try { await page.waitForSelector('#quizBody .opt, #quizBody .cloze-slot', { timeout: 20000 }); } catch (e) { }
          let ans = 0;
          for (let i = 0; i < 40 && !ans; i++) { ans = await answerAllInQuiz(page); if (!ans) await page.waitForTimeout(500); }
          r.answered = ans;
          r.groupOk = ans > 0;
          const sub = page.locator('#groupSubmit');
          if (await sub.count()) {
            let enabled = false;
            try { await page.waitForSelector('#groupSubmit:not([disabled])', { timeout: 8000 }); enabled = true; } catch (e) { }
            if (enabled) {
              await sub.click();
              /* 判分后的 UI 是 #groupBar 里的「本组结果：X/Y 答对」+「完成，返回今日」按钮，
                 不是 .opt.right/.wrongpick（那两个 class 早已不存在，旧断言恒为 false）。 */
              try { await page.waitForSelector('#groupDone, #groupBar b', { timeout: 8000 }); } catch (e) { }
              r.judged = await page.evaluate(() => !!(document.getElementById('groupDone') || /答对/.test((document.getElementById('groupBar') || {}).innerText || '')));
            } else { r.judgedNote = '提交按钮仍 disabled（题未答满，非致命）'; }
          }
        }
        // 导出（blob + a.click()）
        await page.evaluate(() => { const b = document.getElementById('quizBack'); if (b) b.click(); });
        await page.evaluate(() => { const b = document.querySelector('nav button[data-p="backup"]'); if (b) b.click(); });
        await page.waitForTimeout(300);
        try {
          const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.locator('#exportBtn').click()]);
          const p = await dl.path(); r.exportOk = !!(p && fs.existsSync(p) && fs.statSync(p).size > 100);
        } catch (e) { r.exportOk = false; r.exportErr = String(e.message).slice(0, 120); }
        await shot(page, v.id);
      } catch (e) { r.fatal = String(e.message).slice(0, 200); }
      r.violations = violations.length;
      r.sample = violations.slice(0, 4);
      r.pageErrors = pe.length;
      r.peSample = pe.slice(0, 3);
      R.variants.push(r);
      log(`   ${v.id.padEnd(20)} banks=${r.banks} login=${r.loginOk} group=${r.groupOk} judged=${r.judged} export=${r.exportOk} CSP违规=${r.violations} pageerror=${r.pageErrors}${r.fatal ? ' FATAL=' + r.fatal : ''}`);
      if (violations.length) log('      违规样例：' + JSON.stringify(violations.slice(0, 2)));
      await ctx.close();
      await new Promise(res => srv.close(res)); srv = null;
    }
    await browser.close();
    // 固定目录不删：只覆盖同名文件，避免一次性删除 90 个文件触发安全删除护栏

    /* 3) 结论性断言 */
    const by = id => R.variants.find(x => x && x.id === id) || {};
    const base = by('baseline'), A = by('A-unsafe-inline'), B = by('B-strict-no-inline'), C = by('C-strict-with-hash');
    log('\n================ 结论 ================');
    R.summary.usable = { baseline: !!(base.loginOk && base.judged && base.exportOk), A: !!(A.loginOk && A.judged && A.exportOk), B: !!(B.loginOk && B.judged && B.exportOk), C: !!(C.loginOk && C.judged && C.exportOk) };
    log('   可用性（登录+判分+导出全通过）：' + JSON.stringify(R.summary.usable));
    R.summary.recommended = C.csp;
    log('   推荐策略（实测可用、无需 unsafe-inline）:\n     ' + C.csp);
    log('   若无法外链化内联脚本，退而求其次:\n     ' + A.csp);
    t('CSP-A（script-src 含 unsafe-inline）应用完全可用', 'CSP 结论', R.summary.usable.A, JSON.stringify(by('A-unsafe-inline').sample));
    t('CSP-C（script-src 用 sha256 白名单）应用完全可用', 'CSP 结论', R.summary.usable.C, JSON.stringify(by('C-strict-with-hash').sample));
    t('CSP-B（script-src 仅 self）会让应用失效（证明内联脚本必须白名单化）', 'CSP 结论',
      !(B.loginOk && B.judged && B.exportOk) || B.violations > 0, 'violations=' + B.violations + ' usable=' + R.summary.usable.B);

    R.summary.note = 'header 形式 CSP 仅对 http(s) 部署生效；file:// 打开时无响应头，需改用 <meta http-equiv="Content-Security-Policy">（注意 meta 形式不支持 frame-ancestors）。';
    fs.writeFileSync(path.join(DOCS, 'retest-csp-result.json'), JSON.stringify(R, null, 2), 'utf8');
    fs.writeFileSync(path.join(DOCS, 'retest-csp-log.txt'), LINES.join('\n'), 'utf8');
    log('\n已写出 docs/retest-csp-result.json 与 docs/retest-csp-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'retest-csp-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  } finally {
    try { srv && srv.close(); } catch (e) { }
    // 固定 .scratch/csp-fixture 目录保留（已 gitignore），下次运行覆盖写入即可，不做删除
  }
})();
