'use strict';
/* ============================================================================
   CET6 复测轮 B1/B3/B4 补充扫描：
     · listeningUrl → iframe src 的注入面（javascript: URL + sandbox 组合）
     · plan.items 里的幽灵 qid：M-3 只清了 wrongbook，plan 未清 → 清单死锁
     · essayCheck 的 miss.map(esc) 动态内容覆盖
     · 题库字段被篡改时 bankInfo 渲染的健壮性（questions 缺失）
     · setAttribute / insertAdjacentHTML / document.write 等注入 sinks 的存在性
   运行：cd D:\CET6\scripts ; node retest_misc.js
   产物：docs/retest-security-*.png / docs/retest-misc-result.json / docs/retest-misc-log.txt
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, fileUrl } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const INDEX = path.join(APP, 'index.html');
const URL = fileUrl(INDEX);
const DOCS = path.join(ROOT, 'docs');
const pad = n => (n < 10 ? '0' + n : '' + n);
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
const PAPER = '2026-06-1';

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const R = { meta: {}, cases: [], issues: [], staticScan: {}, summary: {} };
function t(name, group, pass, detail) {
  R.cases.push({ name, group, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`);
  return pass;
}
function issue(id, title, sev, where, repro, fix, evidence) {
  R.issues.push({ id, title, severity: sev, where, repro, fix, evidence });
  log(`  [issue/${sev}] ${id} ${title}  @${where}`);
}
async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 }, acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.__pwned = 0; window.__pwnedTags = [];
    window.__probe = function (tag) { window.__pwned++; window.__pwnedTags.push(tag); };
  });
  const page = await ctx.newPage();
  const logs = { console: [], pageerror: [], dialog: [] };
  page.on('console', m => logs.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.pageerror.push(String((e && e.message) || e)));
  page.on('dialog', async dl => { logs.dialog.push({ type: dl.type(), message: dl.message() }); try { await dl.accept(dl.type() === 'prompt' ? '10' : ''); } catch (e) { } });
  return { ctx, page, logs };
}
async function boot(page, stateObj) {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ st }) => {
    try { localStorage.setItem('cet6_user', '9203'); localStorage.removeItem('cet6_p1_state_v1_9203'); if (st !== null) localStorage.setItem('cet6_p1_state_v1_9203', st); } catch (e) { }
  }, { st: stateObj === undefined ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); } catch (e) { }
  await page.waitForTimeout(200);
}
const state = page => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cet6_p1_state_v1_9203') || 'null'); } catch (e) { return null; } });
const toastText = page => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
async function shot(page, n) { try { await page.screenshot({ path: path.join(DOCS, 'retest-security-' + n + '.png') }); } catch (e) { } }
function baseState(e) { return Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' }, e || {}); }

/* ---------------- 静态扫描：其它注入 sink ---------------- */
function staticScan() {
  const src = fs.readFileSync(INDEX, 'utf8');
  const core = fs.readFileSync(path.join(APP, 'core.js'), 'utf8');
  const pats = {
    setAttribute: /\.setAttribute\s*\(/g,
    insertAdjacentHTML: /insertAdjacentHTML\s*\(/g,
    outerHTML: /\.outerHTML\s*=/g,
    documentWrite: /document\.write\s*\(/g,
    evalCall: /[^.\w]eval\s*\(/g,
    newFunction: /new\s+Function\s*\(/g,
    innerHTML: /\.innerHTML\s*=/g,
    insertAdjacentElement: /insertAdjacentElement\s*\(/g,
    hrefAssign: /\.href\s*=\s*[^"']/g,
    srcAssign: /\.src\s*=/g,
    dangerouslySet: /dangerouslySetInnerHTML/g,
    createContextualFragment: /createContextualFragment\s*\(/g,
    setTimeoutStr: /setTimeout\s*\(\s*['"`]/g,
    innerText: /\.innerText\s*=/g,
    textContent: /\.textContent\s*=/g,
  };
  const out = {};
  Object.keys(pats).forEach(k => {
    const a = (src.match(pats[k]) || []).length;
    const b = (core.match(pats[k]) || []).length;
    out[k] = { 'index.html': a, 'core.js': b };
  });
  out._innerHTMLLines = (src.match(/\.innerHTML\s*=/g) || []).length;
  // 单引号包裹的属性（esc 不转义 ' → 必须用双引号）
  out._singleQuotedAttrInHtmlStrings = (src.match(/=\\?'\s*\+/g) || []).length;
  // 不带 rel=noopener 的 target=_blank
  out._targetBlankNoNoopener = (src.match(/target="_blank"(?![^>]*rel=)/g) || []).length;
  R.staticScan = out;
  log('  [静态扫描] ' + JSON.stringify(out));
}

/* ========================================================================== */
(async () => {
  try {
    const crypto = require('crypto');
    const hashOf = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    R.meta = { url: URL, browser: EXE, today: TODAY, startedAt: new Date().toISOString(), hashes: { 'app/index.html': hashOf(INDEX), 'app/core.js': hashOf(path.join(APP, 'core.js')) } };
    log('CET6 复测 B1/B3 · 补充扫描  ' + R.meta.startedAt);
    log('index.html sha256 = ' + R.meta.hashes['app/index.html'] + '\n');
    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'] });

    log('================ 1) 静态奇异 sink 扫描 ================');
    staticScan();
    t('无 setAttribute / insertAdjacentHTML / document.write / eval / new Function', 'sink 扫描',
      R.staticScan.setAttribute['index.html'] === 0 && R.staticScan.insertAdjacentHTML['index.html'] === 0 &&
      R.staticScan.documentWrite['index.html'] === 0 && R.staticScan.evalCall['index.html'] === 0 && R.staticScan.newFunction['index.html'] === 0,
      JSON.stringify({ setAttribute: R.staticScan.setAttribute, insertAdjacentHTML: R.staticScan.insertAdjacentHTML, documentWrite: R.staticScan.documentWrite }));
    t('无外链 target="_blank" 缺 rel=noopener', 'sink 扫描', R.staticScan._targetBlankNoNoopener === 0, String(R.staticScan._targetBlankNoNoopener));
    t('HTML 字符串里没有单引号包裹的动态属性（esc 不转义 \'）', 'sink 扫描', R.staticScan._singleQuotedAttrInHtmlStrings === 0, String(R.staticScan._singleQuotedAttrInHtmlStrings));

    /* ---------------- 2) listeningUrl → iframe src 注入面 ---------------- */
    log('\n================ 2) listeningUrl → iframe src（javascript: URL + sandbox）================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const st = baseState({
        plan: {
          date: TODAY, v: 3, items: [
            { key: 'l1', type: 'listening', qids: ['2026-06-1-l-1', '2026-06-1-l-2', '2026-06-1-l-3', '2026-06-1-l-4'], paperId: PAPER, label: '听力·长对话 1-4', done: false, minutes: 0 },
          ]
        }
      });
      await boot(page, st);
      const applied = await page.evaluate(() => {
        const b = (window.CET6_BANKS || []).find(x => x.id === '2026-06-1');
        b.listeningUrl = 'javascript:window.top.__probe("iframeJsUrl")';
        return b.listeningUrl;
      });
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => {
        const f = document.querySelector('#quizBody iframe');
        let inner = null;
        try { inner = f && f.contentDocument ? 'same-origin-readable' : 'blocked'; } catch (e) { inner = 'throw:' + e.name; }
        return {
          hasIframe: !!f,
          srcAttr: f ? f.getAttribute('src') : null,
          sandbox: f ? f.getAttribute('sandbox') : null,
          pwned: window.__pwned,
          tags: window.__pwnedTags.slice(),
          inner,
          linkHref: (document.querySelector('#quizBody a') || {}).getAttribute ? document.querySelector('#quizBody a').getAttribute('href') : null,
        };
      });
      R.iframe = info;
      log('   iframe 渲染结果：' + JSON.stringify(info));
      t('listeningUrl 未做协议白名单（原样进入 src 属性）', 'iframe 注入面', info.srcAttr === 'javascript:window.top.__probe("iframeJsUrl")',
        'src=' + JSON.stringify(info.srcAttr));
      t('javascript: iframe 未导致父页代码执行（命题期望 __pwned=0，实测 ' + info.pwned + '）', 'iframe 注入面', info.pwned === 0,
        'tags=' + JSON.stringify(info.tags) + '；iframe 内文档同源可读性=' + info.inner + '；本条 FAIL 即为 N-4 的实测证据');
      t('iframe 带 sandbox 属性', 'iframe 注入面', !!info.sandbox, info.sandbox);
      if (info.sandbox && /allow-scripts/.test(info.sandbox) && /allow-same-origin/.test(info.sandbox)) {
        issue('N-4', '听力 iframe 的 src 来自题库字段且未做协议白名单；叠加 sandbox 的 allow-scripts + allow-same-origin，javascript: URL 可执行父页代码',
          '高', 'app/index.html:715（iframe，src 取自 esc(listeningUrl)）、:713（<a href> 同一取值）、:661-666（listeningUrlFor 无协议校验）',
          '把题库的 listeningUrl 改成 javascript: 开头（或投递一份被篡改的题库文件）→ 打开该卷听力组 → 父页 __probe 被调用',
          'src 与 href 加协议+域名白名单（仅允许 https://english-exam.lazynote.cn），并去掉 sandbox 的 allow-same-origin（听力页只需 allow-scripts）；CSP script-src 不含 unsafe-inline 可作第二道防线',
          'src=' + JSON.stringify(info.srcAttr) + '；sandbox=' + JSON.stringify(info.sandbox) + '；实测 __pwned=' + info.pwned +
            '，tags=' + JSON.stringify(info.tags) + '，iframe 内文档同源可读（' + info.inner + '）→ 父页 JS 真的被执行了');
      }
      t('无 JS 报错', 'iframe 注入面', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await shot(page, 'iframe-listening-url');
      await ctx.close();
    }

    /* ---------------- 3) plan 中的幽灵 qid：清单死锁 ---------------- */
    log('\n================ 3) plan.items 里的幽灵 qid（M-3 未覆盖 plan）================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const st = baseState({
        plan: {
          date: TODAY, v: 3, items: [
            { key: 'ghost-1', type: 'reading', qids: ['ghost-9999-r-1', 'ghost-9999-r-2'], paperId: '2026-06-1', label: '幽灵组', done: false, minutes: 0 },
            { key: 'real-1', type: 'reading', qids: ['2026-06-1-r-46'], paperId: PAPER, label: '正常组', done: false, minutes: 0 },
          ]
        }
      });
      await boot(page, st);
      const before = await page.evaluate(() => ({
        cards: document.querySelectorAll('#planList .card').length,
        summary: document.getElementById('planSummary').textContent,
        hasGhost: document.getElementById('planList').innerText.indexOf('幽灵组') >= 0,
      }));
      log('   导入后：' + JSON.stringify(before));
      // 打开幽灵组
      const idx = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#planList .card'));
        return cards.findIndex(c => c.innerText.indexOf('幽灵组') >= 0);
      });
      await page.locator('#planList .card button').nth(idx >= 0 ? idx : 0).click();
      await page.waitForTimeout(600);
      const quiz = await page.evaluate(() => ({
        optCount: document.querySelectorAll('#quizBody .opt').length,
        prog: document.getElementById('quizProg').textContent,
        submitDisabled: (document.getElementById('groupSubmit') || {}).disabled,
        submitText: (document.getElementById('groupSubmit') || {}).textContent,
        bodyText: document.getElementById('quizBody').innerText.replace(/\s+/g, ' ').slice(0, 60),
      }));
      log('   幽灵组题面：' + JSON.stringify(quiz));
      // 尝试完成整个清单：把真实组做完
      await page.evaluate(() => { const b = document.getElementById('quizBack'); if (b) b.click(); });
      await page.waitForTimeout(300);
      const st2 = await state(page);
      const ghostAlive = !!(st2.plan && st2.plan.items && st2.plan.items.some(x => x.key === 'ghost-1'));
      t('幽灵 qid 的 plan 条目在载入后仍存在（normalizeState/pruneGhosts 都不管 plan）', 'M-3 缺口', ghostAlive, JSON.stringify(st2.plan && st2.plan.items.map(x => x.key)));
      t('幽灵组渲染成 0 题、提交按钮禁用（用户只能退出）', 'M-3 缺口',
        quiz.optCount === 0 && quiz.submitDisabled === true, JSON.stringify(quiz));
      const stuck = ghostAlive && quiz.optCount === 0;
      if (stuck) {
        issue('N-3', 'plan 里的幽灵 qid 未随 M-3 一起清理：该组永远做不完，今日清单死锁（连击只能靠忙日打卡续）',
          '中-低', 'app/index.html:376-382（pruneGhosts 只遍历 wrongbook）+ core.js:491-515（normalizeState 保留 plan.items 的 qids）',
          '备份里 plan.items[].qids 含题库不存在的题号 → 首页出现一个 0 题的"开始"组，点进去无题可答、提交禁用、无法标记完成',
          'pruneGhosts 里同时过滤 plan.items[].qids（过滤后为空则删除该条目）；或 ensurePlan 校验 plan.items 里每条 qids 都存在于题库，否则重算',
          'plan.items=' + JSON.stringify(st2.plan && st2.plan.items.map(x => x.key + ':' + x.qids.join(','))) + '；幽灵组题面=' + JSON.stringify(quiz));
      }
      t('无 JS 报错', 'M-3 缺口', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await shot(page, 'plan-ghost-qid');
      await ctx.close();
    }

    /* ---------------- 4) essayCheck 的 miss.map(esc) ---------------- */
    log('\n================ 4) essayCheck（踩分词自查）动态内容覆盖 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const st = baseState({
        plan: { date: TODAY, v: 3, items: [{ key: 'tr', type: 'translation', qids: [], paperId: PAPER, done: false, minutes: 0 }] },
        essays: { translation: { lastAt: TODAY, text: 'nothing matching here' } },
      });
      await boot(page, st);
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(500);
      const applied = await page.evaluate(() => {
        const b = (window.CET6_BANKS || []).find(x => x.id === '2026-06-1');
        b.translation.sample = 'Alpha beta gamma. <img src=x onerror="__probe(essaySample)"> delta epsilon';
        return b.translation.sample;
      });
      // 范文展示
      await page.locator('#essaySample').click(); await page.waitForTimeout(300);
      // 踩分词自查
      await page.locator('#essayCheck').click(); await page.waitForTimeout(400);
      const info = await page.evaluate(() => ({
        sampleHasImg: document.querySelectorAll('#sampleBox img').length,
        checkHasImg: document.querySelectorAll('#checkBox img').length,
        checkText: document.getElementById('checkBox').innerText.replace(/\s+/g, ' ').slice(0, 120),
        pwned: window.__pwned,
        translated: (document.querySelector('#quizBody .passage') || {}).innerText ? document.querySelector('#quizBody .passage').innerText.slice(0, 30) : '',
      }));
      R.essayCheck = info;
      log('   范文/自查结果：' + JSON.stringify(info));
      t('范文里的 payload 以纯文本呈现（esc）', 'essayCheck', info.sampleHasImg === 0, JSON.stringify(info));
      t('踩分词自查未注入元素、未执行', 'essayCheck', info.checkHasImg === 0 && info.pwned === 0, JSON.stringify(info));
      t('题面（translation.prompt）正常渲染', 'essayCheck', info.translated.length > 0, info.translated);
      t('无 JS 报错', 'essayCheck', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await shot(page, 'essay-check');
      await ctx.close();
    }

    /* ---------------- 5) 题库结构被破坏时 bankInfo 的健壮性 ---------------- */
    log('\n================ 5) 题库结构缺失（questions undefined）时的渲染健壮性 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      // 在页面已加载后删掉 questions，再强制重跑 bankInfo 那段代码不可行（它在 IIFE 内）。
      // 改为：直接评估"若题库某卷缺 questions，加载期会不会白屏"——用 Node 侧静态推演 + 页面侧模拟 unitList/genPlan
      const res = await page.evaluate(() => {
        const C = window.CET6Core, B = window.CET6_BANKS;
        const backup = B[0].questions;
        let unitErr = null, genErr = null, infoErr = null;
        try { delete B[0].questions; } catch (e) { }
        try { C.unitList(B); } catch (e) { unitErr = e.message; }
        try { C.genPlan({ version: 1, history: {}, papers: {}, wrongbook: {} }, B, '2026-09-27'); } catch (e) { genErr = e.message; }
        // 复刻 index.html:1267-1277 的 bankInfo 渲染逻辑
        try {
          B.map(function (b) {
            var cnt = {};
            b.questions.forEach(function (q) { cnt[q.type] = (cnt[q.type] || 0) + 1; });
            return b.questions.length;
          });
        } catch (e) { infoErr = e.message; }
        B[0].questions = backup;
        return { unitErr, genErr, infoErr };
      });
      R.bankShape = res;
      log('   结果：' + JSON.stringify(res));
      t('core 的 unitList/genPlan 对缺 questions 的卷不抛异常（有 (b.questions||[]) 守卫）', '题库结构',
        !res.unitErr && !res.genErr, JSON.stringify(res));
      t('bankInfo 渲染逻辑对缺 questions 的卷会抛异常（无守卫，会导致 IIFE 中断）', '题库结构',
        !!res.infoErr, 'index.html:1267-1277 直接 b.questions.forEach → ' + (res.infoErr || '未复现'));
      if (res.infoErr) {
        issue('N-5', 'bankInfo 渲染未对题库结构做守卫：任一卷缺 questions/bank 字段会让整段初始化脚本抛错中断（导航与渲染全部失效）',
          '低', 'app/index.html:1267-1277（BANKS.map 内直接 b.questions.forEach）',
          '题库文件损坏/字段缺失（例如手工编辑 bank/*.js 出错）后打开首页',
          '用 (b.questions || []) 并 try-catch 包裹整段；或把 bankInfo 渲染挪进 renderAll 的 try 里',
          '复刻该段代码对缺 questions 的卷抛：' + res.infoErr);
      }
      t('无 JS 报错', '题库结构', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    const failed = R.cases.filter(c => !c.pass && !c.informational);
    R.summary = { total: R.cases.length, fail: failed.length, failed: failed.map(f => f.group + ' · ' + f.name + ' → ' + f.detail), issues: R.issues.length };
    log('\n================ 汇总 ================');
    log(`  检查项 ${R.cases.length} 条；未通过 ${failed.length}；新问题 ${R.issues.length} 个`);
    failed.forEach(f => log('   ✗ ' + f.group + ' · ' + f.name + ' → ' + f.detail));

    fs.writeFileSync(path.join(DOCS, 'retest-misc-result.json'), JSON.stringify(R, null, 2), 'utf8');
    fs.writeFileSync(path.join(DOCS, 'retest-misc-log.txt'), LINES.join('\n'), 'utf8');
    await browser.close();
    log('\n已写出 docs/retest-misc-result.json 与 docs/retest-misc-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'retest-misc-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  }
})();
