'use strict';
/* ============================================================================
   CET6 真题打卡应用 · 安全与健壮性审计（P-SEC）
   被测：D:\CET6\app\index.html（单文件 PWA）+ D:\CET6\app\core.js
   维度：① XSS 注入面  ② 导入脏数据健壮性  ③ localStorage 边界
        ④ 导出/导入安全  ⑤ 控制台零报错（完整旅程） ⑥ file:// 下 SW 行为

   运行：cd D:\CET6\scripts ; node test_security_audit.js
   产物：docs/security-*.png 截图 / docs/security-audit-log.txt / docs/security-audit-result.json
   说明：只读测试，不修改 index.html 与 core.js。
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, ensurePaper, ensureAllPapers } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const INDEX = path.join(APP, 'index.html');
const URL = 'file:///' + INDEX.split(path.sep).join('/');
const DOCS = path.join(ROOT, 'docs');

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const R = { meta: {}, xss: [], dirty: [], storage: [], exp: [], journey: [], sw: [] };
const P = (sec, obj) => { R[sec].push(obj); return obj; };

const pad = n => (n < 10 ? '0' + n : '' + n);
const _d = new Date();
const TODAY = _d.getFullYear() + '-' + pad(_d.getMonth() + 1) + '-' + pad(_d.getDate());

/* ---------------- XSS 探针 payload ----------------
   探测原理：
   - <img src=x onerror=...> / <svg onload=...> 只有被 innerHTML 解析成真实元素才会执行；
   - 因此 window.__pwned 递增 = 代码执行；document 中出现 img[src=x] = 被当成 HTML 解析（注入成功）；
   - 若被 esc() 转义，则 payload 只会以纯文本出现，__pwned 不增长。                       */
const PL = {
  img: '<img src=x onerror="__probe(\'img\')">',
  svg: '<svg onload="__probe(\'svg\')"></svg>',
  attr: '"><img src=x onerror="__probe(\'attr\')">',
  sq: '\'><img src=x onerror="__probe(\'sq\')">',
  script: '<script>__probe(\'script\')<' + '/script>',
};

const CONTAINERS = ['#planList', '#statGrid', '#heatmap', '#dueList', '#allWrongList',
  '#quizBody', '#accTable', '#ptTable', '#bankInfo', '#todayMinutes', '#backupHint', '#checkBox'];

async function probe(page) {
  return await page.evaluate((sels) => {
    let html = '';
    const counts = {};
    sels.forEach(s => {
      const el = document.querySelector(s);
      counts[s] = el
        ? { img: el.querySelectorAll('img[src="x"]').length, svg: el.querySelectorAll('svg').length }
        : null;
      if (el) html += el.outerHTML;
    });
    const i = html.indexOf('__probe');
    return {
      pwned: window.__pwned || 0,
      tags: (window.__pwnedTags || []).slice(),
      imgs: document.querySelectorAll('img[src="x"]').length,
      svgs: document.querySelectorAll('svg').length,
      counts,
      singleQuotedAttrs: (html.match(/='[^']*'/g) || []).length,
      evidence: i < 0 ? '' : html.slice(Math.max(0, i - 100), i + 120).replace(/\s+/g, ' '),
    };
  }, CONTAINERS);
}
/* 目标容器里"真的多出了 img/svg 元素"= payload 被当 HTML 解析；这比数增量可靠（不受上一用例残留影响） */
const cnt = (pr, sels) => (sels || []).reduce((a, s) => a + (pr.counts[s] ? pr.counts[s].img + pr.counts[s].svg : 0), 0);

async function newCtx(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.__pwned = 0; window.__pwnedTags = [];
    window.__probe = function (t) { window.__pwned++; window.__pwnedTags.push(t); };
  });
  const page = await ctx.newPage();
  const logs = {
    console: [], pageerror: [], dialog: [], promptReply: '10',
    onConsole: m => logs.console.push({ type: m.type(), text: m.text() }),
  };
  page.on('console', logs.onConsole);
  page.on('pageerror', e => logs.pageerror.push(String((e && e.message) || e)));
  page.on('dialog', async dl => {
    logs.dialog.push({ type: dl.type(), message: dl.message() });
    try { await dl.accept(dl.type() === 'prompt' ? logs.promptReply : ''); } catch (e) { }
  });
  ctx._label = label; ctx._logs = logs;
  return { ctx, page, logs };
}
const cur = logs => ({ c: logs.console.length, p: logs.pageerror.length });
const since = (logs, k) => ({
  errors: logs.pageerror.slice(k.p),
  console: logs.console.slice(k.c).filter(m => m.type === 'error' || m.type === 'warning'),
});

async function boot(page, userId, stateObj) {
  await page.goto(URL, { waitUntil: 'load' });
  // 注意：'#loginMask, #planList' 不行——#planList 是空 div（不可见）且 DOM 在前，会误判超时
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ id, st }) => {
    try { localStorage.setItem('cet6_user', id); } catch (e) { }
    try { if (st !== null) localStorage.setItem('cet6_p1_state_v1_' + id, st); } catch (e) { }
  }, { id: userId, st: stateObj === undefined ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); }
  catch (e) { log('   ⚠ boot(' + userId + ') 重载后 20s 内今日清单无卡片：' + e.message.split('\n')[0]); }
  await page.waitForTimeout(400);
}

const importRaw = async (page, body, filename, mime) => {
  await page.setInputFiles('#importFile', {
    name: filename || 'cet6-backup-test.json',
    mimeType: mime || 'application/json',
    buffer: Buffer.from(body, 'utf8'),
  });
  await page.waitForTimeout(700);
};
const importObj = (page, obj, filename) => importRaw(page, JSON.stringify(obj), filename);

const toastText = page => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
const planCards = page => page.locator('#planList .card').count();
const storeGet = (page, key) => page.evaluate(k => localStorage.getItem(k), key);
async function shot(page, name, full) {
  try { await page.screenshot({ path: path.join(DOCS, 'security-' + name + '.png'), fullPage: !!full }); }
  catch (e) { log('   (截图失败 ' + name + ': ' + e.message + ')'); }
}
/* 基准良好存档：带 GOODMARK 便于判断"导入失败后旧数据是否被覆盖" */
const GOOD = 'GOODMARK987';
function goodState(extra) {
  const s = {
    version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {},
    lastBackup: '', __good: GOOD,
  };
  s.history[TODAY] = { minutes: 12, done: false, floor: false, qCount: 8, right: 6, timed: 1, timedWithin: 1, timedSec: 70 };
  return Object.assign(s, extra || {});
}

/* ========================================================================== */
(async () => {
  try {
  R.meta = { url: URL, browser: EXE, today: TODAY, node: process.version, startedAt: new Date().toISOString() };
  log('CET6 安全与健壮性审计  ' + R.meta.startedAt);
  log('页面：' + URL + '\n浏览器：' + EXE + '  今日：' + TODAY + '\n');

  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  /* 取几个真实 qid / paper id，供构造 payload 使用 */
  const { ctx: c0, page: p0 } = await newCtx(browser, 'probe');
  await p0.goto(URL, { waitUntil: 'load' });
  await p0.waitForSelector('#loginMask', { timeout: 30000 });
  const IDS = await p0.evaluate(() => {
    // 懒加载架构：BANKS 启动为空（按需加载卷）。取样例 qid 改走 meta 骨架（CET6_META.qLite 含 id/type/qno）。
    const M = window.CET6_META || { papers: {} };
    const all = [];
    Object.keys(M.papers).forEach(pid => (M.papers[pid].qLite || []).forEach(q => all.push(q)));
    const pick = t => { const q = all.find(x => x.type === t); return q ? q.id : null; };
    const rb = (M.papers['2015-06-1'] || {}).qLite || [];
    const r5 = rb.filter(q => q.type === 'reading').slice(0, 5).map(q => q.id);
    return {
      banks: Object.keys(M.papers).length,
      reading: pick('reading'), listening: pick('listening'), cloze: pick('cloze'), match: pick('match'),
      r5, rqno: (rb.filter(q => q.type === 'reading')[0] || {}).qno,
    };
  });
  log('题库：' + IDS.banks + ' 卷；样例 qid reading=' + IDS.reading + ' listening=' + IDS.listening);
  // 当前排期版本：plan 注入必须用与核心一致的版本，否则会被 ensurePlan 丢弃重生成
  const PV = await p0.evaluate(() => (window.CET6Core || {}).PLAN_VERSION || 0);
  log('当前排期版本 PLAN_VERSION=' + PV);
  await c0.close();

  /* ======================================================================
     ① XSS 注入面
     ====================================================================== */
  log('\n=========== ① XSS 注入面 ===========');
  const { ctx: c1, page: p1, logs: l1 } = await newCtx(browser, 'xss');

  /* --- 1.1 登录编号：白名单 /^\d{4}$/ --- */
  await p1.goto(URL, { waitUntil: 'load' });
  await p1.waitForSelector('#loginMask', { timeout: 30000 });
  for (const v of ['abcd', '12a4', '123', '9e03', PL.img.slice(0, 4) + '5', '12 4']) {
    const k = cur(l1);
    await p1.locator('#phoneInput').fill(v).catch(() => { });
    await p1.locator('#loginBtn').click().catch(() => { });
    await p1.waitForTimeout(200);
    const got = await storeGet(p1, 'cet6_user');
    const s = since(l1, k);
    const dl = l1.dialog.length ? l1.dialog[l1.dialog.length - 1] : {};
    P('xss', {
      name: '登录输入 ' + JSON.stringify(v), sink: 'index.html:371-372 alert + /^\\d{4}$/',
      payload: v, blocked: !got, alert: dl.message || '', injected: false, executed: false,
    });
    log('  · 登录输入 ' + JSON.stringify(v) + ' → 拦截=' + (!got ? '是' : '否(已写入 cet6_user)') + ' 提示=' + JSON.stringify(dl.message || ''));
  }
  /* 直接污染 localStorage 的登录态 */
  await p1.evaluate(p => localStorage.setItem('cet6_user', p), PL.img);
  await p1.reload({ waitUntil: 'load' });
  await p1.waitForTimeout(400);
  const pr0 = await probe(p1);
  const maskVisible = await p1.locator('#loginMask').count();
  const chipTxt = await p1.evaluate(() => (document.getElementById('userChip') || {}).textContent || '');
  P('xss', {
    name: 'localStorage cet6_user 直接写入 HTML payload', sink: 'index.html:351 /^\\d{4}$/.test(user) → showLogin()',
    payload: PL.img, injected: pr0.imgs > 0, executed: pr0.pwned > 0, loginMask: maskVisible > 0, chip: chipTxt,
  });
  log('  · cet6_user 注入 payload → 登录层出现=' + (maskVisible > 0) + ' 注入元素=' + pr0.imgs + ' 执行=' + pr0.pwned + ' userChip文本=' + JSON.stringify(chipTxt));

  /* --- 1.2 写作/翻译草稿 textarea --- */
  await boot(p1, '9203', goodState({
    plan: {
      date: TODAY, v: PV,
      items: [{ key: 'essay-test', type: 'writing', qids: [], paperId: '2015-06-1', done: false, minutes: 0 }],
    },
  }));
  await p1.locator('#planList .card button').first().click();
  await p1.waitForSelector('#essayTa', { timeout: 10000 });
  const ESSAY = PL.img + PL.attr + PL.sq + PL.script;
  await p1.locator('#essayTa').fill(ESSAY);
  await p1.waitForTimeout(300);
  await p1.locator('#essaySample').click().catch(() => { });
  await p1.locator('#essayCheck').click().catch(() => { });
  await p1.waitForTimeout(300);
  const pEssay1 = await probe(p1);
  await p1.locator('#quizBack').click().catch(() => { });
  await p1.waitForTimeout(300);
  await p1.locator('#planList .card button').first().click().catch(() => { });
  await p1.waitForTimeout(500);
  const taVal = await p1.inputValue('#essayTa').catch(() => '');
  const pEssay2 = await probe(p1);
  const essayStored = await p1.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('cet6_p1_state_v1_9203') || '{}').essays; } catch (e) { return null; }
  });
  P('xss', {
    name: '写作草稿 textarea 输入 XSS payload', sink: 'index.html:635 esc(draft) / 642-644 oninput / 962,984 esc()',
    payload: ESSAY, injected: (pEssay1.imgs + pEssay2.imgs) > 0, executed: (pEssay1.pwned + pEssay2.pwned) > 0, injectedImgs: pEssay1.imgs + pEssay2.imgs,
    roundTrip: taVal === ESSAY, storedText: essayStored && essayStored.writing ? essayStored.writing.text : null,
    singleQuotedAttrs: pEssay2.singleQuotedAttrs,
  });
  log('  · 写作草稿 textarea 注入 4 种 payload → 执行=' + ((pEssay1.pwned + pEssay2.pwned) > 0) +
    ' 注入元素=' + (pEssay1.imgs + pEssay2.imgs) + ' 退出重进回填一致=' + (taVal === ESSAY));
  await shot(p1, 'xss-essay-draft', true);
  await p1.locator('#quizBack').click().catch(() => { });
  await p1.waitForTimeout(300);

  /* --- 1.3 导入备份 → 各渲染路径 XSS --- */
  const closeQuiz = async () => {                 // 做题浮层会拦截点击，用例之间必须关掉
    if (await p1.locator('#quiz.show').count()) {
      await p1.locator('#quizBack').click().catch(() => { });
      await p1.waitForTimeout(450);
    }
  };
  const xssCase = async (name, sink, payload, stateObj, after, targetSels) => {
    await closeQuiz();
    const k = cur(l1);
    const pre = await probe(p1);                  // 逐用例取增量，避免累计计数造成假阳性
    await importObj(p1, stateObj);
    await p1.waitForTimeout(300);
    if (after) {
      try { await after(); } catch (e) { log('   (after 步骤异常，跳过：' + String(e.message || e).split('\n')[0] + ')'); }
    }
    await p1.waitForTimeout(400);
    const t = await toastText(p1);
    const pr = await probe(p1);
    const targets = targetSels || CONTAINERS;
    const rec = P('xss', {
      name, sink, payload, toast: t, targets,
      pwnedDelta: pr.pwned - pre.pwned, pwnedTotal: pr.pwned,
      injectedElementsInTargets: cnt(pr, targets), injectedImgs: pr.imgs, injectedSvgs: pr.svgs,
      injected: cnt(pr, targets) > 0,               // 目标容器里出现真实 <img src=x>/<svg> 元素即注入成立
      executed: pr.pwned > pre.pwned,
      singleQuotedAttrs: pr.singleQuotedAttrs, evidence: pr.evidence, errors: since(l1, k).errors,
    });
    log('  · ' + name + '\n      → 注入成立=' + rec.injected + ' 代码执行=' + rec.executed +
      ' (pwned+' + rec.pwnedDelta + ' 目标容器内元素=' + rec.injectedElementsInTargets + ') toast=' + JSON.stringify(t) +
      (rec.errors.length ? ' 页面报错=' + rec.errors.length : ''));
    if (rec.evidence) log('      证据HTML: ' + rec.evidence.slice(0, 150));
    return rec;
  };

  // (a) history.minutes → 统计页 statCell(innerHTML) + 热力图 title 属性
  await xssCase(
    '导入 history.minutes → 统计页', 'index.html:1045 热力图 title="…+d.minutes" / 1055 statCell(\'今日\', h.minutes+\' 分钟\')',
    PL.attr,
    goodState({ history: { [TODAY]: { minutes: PL.attr, done: true, floor: false, qCount: 1, right: 1, timed: 0 } } }),
    () => p1.locator('nav button[data-p="stat"]').click(), ['#statGrid', '#heatmap']);
  await shot(p1, 'xss-history-minutes-stat', true);

  // (b) wrongbook.due → 错题本
  const wbBase = { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 };
  await xssCase(
    '导入 wrongbook.due → 错题本', 'index.html:931 "下次到期 " + wb.due（未转义）',
    PL.attr,
    goodState({ wrongbook: { [IDS.reading]: Object.assign({}, wbBase, { due: PL.attr }) } }),
    () => p1.locator('nav button[data-p="wrong"]').click(), ['#dueList', '#allWrongList']);
  await shot(p1, 'xss-wrongbook-due', true);

  // (c) wrongbook.wrongCount → 错题本
  await xssCase(
    '导入 wrongbook.wrongCount → 错题本', 'index.html:931 "错 " + wb.wrongCount + " 次"（未转义）',
    PL.img,
    goodState({ wrongbook: { [IDS.reading]: Object.assign({}, wbBase, { wrongCount: PL.img }) } }),
    () => p1.locator('nav button[data-p="wrong"]').click(), ['#dueList', '#allWrongList']);
  // (c2) 同一 sink 换 SVG 载荷：元素注入成立但 onload 不触发（说明"注入"与"执行"要分开判定）
  await xssCase(
    '导入 wrongbook.wrongCount（SVG 载荷）', 'index.html:931 同上，载荷 <svg onload>',
    PL.svg,
    goodState({ wrongbook: { [IDS.reading]: Object.assign({}, wbBase, { wrongCount: PL.svg }) } }),
    () => p1.locator('nav button[data-p="wrong"]').click(), ['#dueList', '#allWrongList']);

  // (d) papers[].seen → 统计页累计做题 / 正确率表 / 估分卡
  await xssCase(
    '导入 papers[].seen → 统计页', 'index.html:1048 totalQ += papers[id].seen / 1056 statCell / 1064 accTable / 1082 estCard p.seen',
    PL.img,
    goodState({ papers: { [IDS.reading]: { seen: PL.img, right: 0, wrong: 0, lastAt: TODAY } } }),
    () => p1.locator('nav button[data-p="stat"]').click(), ['#statGrid', '#accTable', '#ptTable']);
  await shot(p1, 'xss-papers-seen-stat', true);

  // (e) history.timed → 统计页限时达标
  await xssCase(
    '导入 history.timed → 统计页', 'index.html:1051 timedAll += x.timed / 1058 statCell(\'限时达标\', timedOk+\'/\'+timedAll)',
    PL.img,
    goodState({ history: { [TODAY]: { minutes: 1, done: true, floor: false, timed: PL.img, timedWithin: 1, timedSec: 0, qCount: 0, right: 0 } } }),
    () => p1.locator('nav button[data-p="stat"]').click(), ['#statGrid']);

  // (f) plan.items[].label / paperId / type → 今日清单
  await xssCase(
    '导入 plan.label / paperId / type → 今日清单', 'index.html:453-458 esc() 覆盖 label/paperId/meta.zh',
    PL.attr + PL.img,
    goodState({
      plan: {
        date: TODAY, v: PV, items: [{
          key: 'k', type: PL.attr, qids: [IDS.reading], paperId: PL.img, label: PL.attr, done: false, minutes: 0,
        }],
      },
    }),
    null, ['#planList']);
  await shot(p1, 'xss-plan-label', true);

  // (g) hl 数组 → 阅读划词高亮（createTextNode 路径）
  const planReading = {
    date: TODAY, v: PV,
    items: [{ key: 'r', type: 'reading', qids: IDS.r5, paperId: '2015-06-1', done: false, minutes: 0 }],
  };
  await boot(p1, '9203', goodState({ plan: planReading }));
  await p1.locator('#planList .card button').first().click();
  await p1.waitForSelector('#quizBody .passage', { timeout: 10000 });
  const PID = await p1.evaluate(() => document.querySelector('#quizBody .passage').getAttribute('data-pid'));
  await p1.locator('#quizBack').click();
  await p1.waitForTimeout(300);
  log('  阅读组 passage data-pid = ' + PID);
  await xssCase(
    '导入 hl[pid] = [payload] → 划词高亮', 'index.html:806-829 restoreHl（createTextNode 插入）',
    PL.img, goodState({ plan: planReading, hl: { [PID]: [PL.img] } }),
    async () => { await p1.locator('#planList .card button').first().click(); await p1.waitForTimeout(500); }, ['#quizBody']);

  // (h) essays[].text → 写作文本框
  await xssCase(
    '导入 essays.writing.text → 写作文本框', 'index.html:631-635 esc(draft)',
    PL.img + PL.attr,
    goodState({
      plan: { date: TODAY, v: PV, items: [{ key: 'e', type: 'writing', qids: [], paperId: '2015-06-1', done: false, minutes: 0 }] },
      essays: { writing: { lastAt: TODAY, text: PL.img + PL.attr } },
    }),
    async () => { await p1.locator('#planList .card button').first().click(); await p1.waitForTimeout(500); }, ['#quizBody']);
  await shot(p1, 'xss-essays-text', false);

  /* 恢复：正常状态可 import 恢复 */
  const kRec = cur(l1);
  await importObj(p1, goodState());
  await p1.waitForTimeout(500);
  const recToast = await toastText(p1);
  P('xss', { name: 'XSS 注入后恢复（导入正常备份）', toast: recToast, recovered: /导入成功/.test(recToast), errors: since(l1, kRec).errors });
  log('  · 注入后导入正常备份恢复：' + JSON.stringify(recToast));
  await c1.close();

  /* --- 1.4 题库数据被篡改时的渲染路径（bankInfo:1190-1200 / matchParagraphs:672 未转义）---
     说明：bank/*.js 是本地静态文件，普通用户无法通过导入/输入触达；此处用挂钩 window.CET6_BANKS
     的方式篡改题库，仅为验证这两处 sink 的 XSS 可达性（能改本地文件的人本就能执行任意 JS）。 */
  {
    const { ctx: cb, page: pb, logs: lb } = await newCtx(browser, 'bank-tamper');
    await cb.addInitScript(() => {
      let _b = null;
      Object.defineProperty(window, 'CET6_BANKS', {
        configurable: true,
        get() { return _b; },
        set(v) {
          _b = v;
          if (Array.isArray(v) && !v.__hooked) {
            Object.defineProperty(v, '__hooked', { value: true, enumerable: false });
            const orig = v.push.bind(v);
            v.push = function (p) {
              if (p && p.id === '2015-06-1') {
                if (p.questions && p.questions.length) p.questions[0].type = '<img src=x onerror="__probe(\'bankinfo\')">';
                if (p.matchParagraphs && p.matchParagraphs.length) p.matchParagraphs[0].text = '<img src=x onerror="__probe(\'matchpara\')">';
              }
              return orig(p);
            };
          }
        },
      });
    });
    await boot(pb, '9601');
    await pb.waitForTimeout(400);
    // 按需加载：先注入目标卷，使篡改钩子（重写 CET6_BANKS.push）真正生效，bankInfo 才有内容可渲染
    await ensurePaper(pb, '2015-06-1');
    await pb.waitForTimeout(300);
    const prB = await probe(pb);
    const mq = await pb.evaluate(() => {
      const b = (window.CET6_BANKS || []).find(x => x.id === '2015-06-1');
      return b ? b.questions.filter(q => q.type === 'match').map(q => q.id) : [];
    });
    P('xss', {
      name: '题库 questions[].type 被篡改 → bankInfo 渲染', sink: 'index.html:1190-1200 (TYPE_ZH[t] || t) 未转义',
      payload: '<img src=x onerror=__probe(bankinfo)> 放入 questions[0].type',
      injected: cnt(prB, ['#bankInfo']) > 0, injectedInBankInfo: cnt(prB, ['#bankInfo']), executed: prB.pwned > 0, pwnedDelta: prB.pwned,
      reachability: '需篡改本地 bank/*.js 文件（非用户输入/导入可达）',
      evidence: prB.evidence.slice(0, 200),
    });
    log('  · [题库篡改] questions[].type → bankInfo：注入=' + (cnt(prB, ['#bankInfo']) > 0) + ' 执行=' + (prB.pwned > 0) +
      '（可达性：需改本地题库文件，普通用户不可达）');
    if (prB.evidence) log('      证据HTML: ' + prB.evidence.slice(0, 150));

    const kM = cur(lb);
    await importObj(pb, goodState({
      plan: { date: TODAY, v: PV, items: [{ key: 'm', type: 'match', qids: mq, paperId: '2015-06-1', done: false, minutes: 0 }] },
    }));
    await pb.waitForTimeout(400);
    const preM = await probe(pb);
    await pb.locator('#planList .card button').first().click().catch(() => { });
    await pb.waitForTimeout(900);
    const prM = await probe(pb);
    P('xss', {
      name: '题库 matchParagraphs[].text 被篡改 → 做题页段落', sink: 'index.html:672 "[label] " + p.text 未转义',
      payload: '<img src=x onerror=__probe(matchpara)> 放入 matchParagraphs[0].text',
      injected: cnt(prM, ['#quizBody']) > 0, executed: prM.pwned > preM.pwned,
      pwnedDelta: prM.pwned - preM.pwned, errors: since(lb, kM).errors,
      reachability: '需篡改本地 bank/*.js 文件（非用户输入/导入可达）',
      evidence: (await probe(pb)).evidence.slice(0, 200),
    });
    log('  · [题库篡改] matchParagraphs[].text → 做题页：注入=' + (cnt(prM, ['#quizBody']) > 0) +
      ' 执行=' + (prM.pwned > preM.pwned) + '（可达性同上）');
    await shot(pb, 'xss-bank-tamper', true);
    await cb.close();
  }

  /* ======================================================================
     ② 导入脏数据健壮性
     ====================================================================== */
  log('\n=========== ② 导入脏数据健壮性 ===========');
  // 注意：c2/p2/l2 必须是 let —— 单个用例把渲染进程跑崩后要能整体重建再继续（见 dirtyCase 的 catch）
  let { ctx: c2, page: p2, logs: l2 } = await newCtx(browser, 'dirty');
  await boot(p2, '9203', goodState());

  const BM = 'BADMARK123';
  const dirtyCase = async (name, body, opts) => {
    opts = opts || {};
    try {
    // fresh: 大体积用例（MB 级文本）前重载页面，释放前序用例累计的 DOM/字符串
    if (opts.fresh) { await boot(p2, '9203', goodState()); }
    // 先恢复良好存档，便于判断"旧数据是否被覆盖"
    await importObj(p2, goodState());
    await p2.waitForTimeout(400);
    const k = cur(l2);
    const t0 = Date.now();
    await importRaw(p2, body, opts.file || 'dirty.json', opts.mime || 'application/json');
    const ms = Date.now() - t0;
    const t = await toastText(p2);
    const errsImport = since(l2, k).errors;
    let extra = {};
    if (opts.then) { try { extra = (await opts.then()) || {}; } catch (e) { extra = { thenThrew: e.message }; } }
    const k2 = cur(l2);
    for (const pg of ['wrong', 'stat', 'backup', 'today']) {
      await p2.locator('nav button[data-p="' + pg + '"]').click().catch(() => { });
      await p2.waitForTimeout(150);
    }
    const errsNav = since(l2, k2).errors;
    const st = await storeGet(p2, 'cet6_p1_state_v1_9203');
    const badPersisted = !!(st && st.indexOf(BM) >= 0);
    const oldSurvived = !!(st && st.indexOf(GOOD) >= 0);
    // 重新加载后的表现（用户重开页面的真实体验）
    const k3 = cur(l2);
    await p2.reload({ waitUntil: 'load' });
    await p2.waitForTimeout(700);
    const errsReload = since(l2, k3).errors;
    const cardsReload = await planCards(p2).catch(() => -1);
    const rec = P('dirty', {
      name, file: opts.file || 'dirty.json', bytes: Buffer.byteLength(body, 'utf8'), ms,
      toast: t, rejected: /导入失败/.test(t),
      errsOnImport: errsImport, errsAfterNav: errsNav, errsAfterReload: errsReload,
      cardsAfterReload: cardsReload, badPersisted, oldDataSurvived: oldSurvived,
      uniqueErrors: [...new Set([].concat(errsImport, errsNav, errsReload))].map(e => e.slice(0, 160)),
      ...extra,
    });
    log('  · ' + name +
      '\n      提示=' + JSON.stringify(t) + ' 耗时=' + ms + 'ms' +
      '\n      报错: 导入时' + errsImport.length + ' / 导航后' + errsNav.length + ' / 重载后' + errsReload.length +
      ' | 重载后今日卡片=' + cardsReload + ' | 新数据落盘=' + badPersisted + ' 旧数据保留=' + oldSurvived +
      (extra.extraNote ? ' | ' + extra.extraNote : ''));
    if (rec.uniqueErrors.length) rec.uniqueErrors.forEach(e => log('        ⛔ ' + e));
    return rec;
    } catch (e) {
      /* 渲染进程被系统回收（Target crashed / 页面失效）时，不能让整份审计中断。
         定级依据：独立探针 _probe_bigimport.js 在"全新页面 + 首个动作"下导入同一份 MB 级
         载荷可正常完成（toast=导入成功、0 pageerror、重载后清单正常），
         故此处属于长时间自动化跑批的环境资源限制，而非应用缺陷。 */
      const msg = String((e && e.message) || e).split('\n')[0];
      const rec = P('dirty', {
        name, bytes: Buffer.byteLength(body, 'utf8'),
        envLimited: true, crashed: true, crashError: msg,
        note: '长跑累积导致渲染进程被回收；独立探针证明全新页面上同一载荷可正常导入 → 环境限制，非应用缺陷',
      });
      log('  · ' + name + '\n      ⚠ 渲染进程中断（' + msg + '）→ 记为"环境限制"，重建页面后继续后续用例');
      try { await c2.close(); } catch (_) { }
      const re = await newCtx(browser, 'dirty-recover');
      c2 = re.ctx; p2 = re.page; l2 = re.logs;
      await boot(p2, '9203', goodState()).catch(() => { });
      return rec;
    }
  };

  // a) 语法损坏
  await dirtyCase('截断 JSON（语法错误）', '{"version":1,"history":{"20');
  await dirtyCase('纯文本文件 .txt', '这是一份普通文本，不是备份文件', { file: 'notes.txt', mime: 'text/plain' });
  await dirtyCase('HTML 文件', '<html><body><h1>不是备份</h1></body></html>', { file: 'page.html', mime: 'text/html' });
  await dirtyCase('其它 JSON 结构 {"foo":1}', '{"foo":1}');
  await dirtyCase('JSON 数组 []', '[]');
  await dirtyCase('JSON null', 'null');
  // b) 类型错乱 / 缺字段
  await dirtyCase('缺 papers/wrongbook', JSON.stringify({ version: 1, history: {}, __bad: BM }));
  await dirtyCase('version 为字符串 "1"', JSON.stringify({ version: '1', history: {}, papers: {}, wrongbook: {}, __bad: BM }));
  await dirtyCase('history 为数组', JSON.stringify({ version: 1, history: [], papers: {}, wrongbook: {}, __bad: BM }));
  await dirtyCase('history[今日] = null', JSON.stringify({ version: 1, history: { [TODAY]: null }, papers: {}, wrongbook: {}, __bad: BM }));
  await dirtyCase('history[今日].minutes 为对象', JSON.stringify({ version: 1, history: { [TODAY]: { minutes: {}, done: true, floor: false } }, papers: {}, wrongbook: {}, __bad: BM }));
  await dirtyCase('papers[qid] = null', JSON.stringify({ version: 1, history: {}, papers: { [IDS.listening]: null }, wrongbook: {}, __bad: BM }));
  await dirtyCase('wrongbook[qid] = null', JSON.stringify({ version: 1, history: {}, papers: {}, wrongbook: { [IDS.listening]: null }, __bad: BM }));
  // c) 结构错乱
  await dirtyCase('plan.items 为对象（非数组）', JSON.stringify({
    version: 1, history: {}, papers: {}, wrongbook: {},
    plan: { date: TODAY, v: PV, items: {} }, __bad: BM,
  }));
  await dirtyCase('plan 引用不存在 qid + 预置 draft → 提交判分', JSON.stringify({
    version: 1, history: {}, papers: {}, wrongbook: {},
    plan: {
      date: TODAY, v: PV,
      items: [{ key: 'x', type: 'reading', qids: ['no-such-qid-9999'], paperId: '2015-06-1', done: false, minutes: 0, draft: { 'no-such-qid-9999': 'A' } }],
    }, __bad: BM,
  }), {
    then: async () => {
      await p2.locator('nav button[data-p="today"]').click().catch(() => { });
      await p2.waitForTimeout(200);
      await p2.locator('#planList .card button').first().click().catch(() => { });
      await p2.waitForTimeout(400);
      const kk = cur(l2);
      const submitDisabled = await p2.locator('#groupSubmit').isDisabled().catch(() => null);
      await p2.locator('#groupSubmit').click().catch(() => { });
      await p2.waitForTimeout(400);
      const e = since(l2, kk).errors;
      return { extraNote: '提交前按钮 disabled=' + submitDisabled + ' 判分报错=' + e.length, judgeErrors: e.map(x => x.slice(0, 160)) };
    },
  });
  // d) 缺 essays 但有写作条目
  await dirtyCase('缺 essays 字段 + 清单含写作条目', JSON.stringify({
    version: 1, history: {}, papers: {}, wrongbook: {},
    plan: { date: TODAY, v: PV, items: [{ key: 'e', type: 'writing', qids: [], paperId: '2015-06-1', done: false, minutes: 0 }] },
    __bad: BM,
  }), {
    then: async () => {
      const kk = cur(l2);
      await p2.locator('nav button[data-p="today"]').click().catch(() => { });
      await p2.waitForTimeout(200);
      await p2.locator('#planList .card button').first().click().catch(() => { });
      await p2.waitForTimeout(500);
      const e = since(l2, kk).errors;
      const hasTa = await p2.locator('#essayTa').count();
      return { extraNote: '进入写作组后 textarea 渲染=' + hasTa + ' 报错=' + e.length, essayErrors: e.map(x => x.slice(0, 160)) };
    },
  });
  // e) 超长文本
  await dirtyCase('单字段 1MB 超长文本 ×2', JSON.stringify({
    version: 1, history: { [TODAY]: { minutes: 'x'.repeat(1024 * 1024), done: true, floor: false, qCount: 0, right: 0 } },
    papers: {}, wrongbook: {}, blob: 'y'.repeat(1024 * 1024), __bad: BM,
  }), { fresh: true });
  await dirtyCase('hl[pid] 为非数组（{length:5}）', JSON.stringify({
    version: 1, history: {}, papers: {}, wrongbook: {},
    plan: { date: TODAY, v: PV, items: [{ key: 'r', type: 'reading', qids: IDS.r5, paperId: '2015-06-1', done: false, minutes: 0 }] },
    hl: { ['2015-06-1#reading#read0']: { length: 5 } }, __bad: BM,
  }), {
    then: async () => {
      const kk = cur(l2);
      await p2.locator('nav button[data-p="today"]').click().catch(() => { });
      await p2.waitForTimeout(200);
      await p2.locator('#planList .card button').first().click().catch(() => { });
      await p2.waitForTimeout(500);
      const e = since(l2, kk).errors;
      const passages = await p2.locator('#quizBody .passage').count();
      return { extraNote: '进入阅读组后 passage=' + passages + ' 报错=' + e.length, hlErrors: e.map(x => x.slice(0, 160)) };
    },
  });
  await shot(p2, 'dirty-final-state', true);
  await c2.close();

  /* ======================================================================
     ③ localStorage 边界
     ====================================================================== */
  log('\n=========== ③ localStorage 边界 ===========');
  const { ctx: c3, page: p3, logs: l3 } = await newCtx(browser, 'storage');

  // 3.1 配额耗尽时 save() 行为
  await boot(p3, '9301', goodState());
  // 逐级填满：只填 100KB 块会留有余量（旧版结论因此不可用），必须填到"连 32 字节都写不进去"
  const fill = await p3.evaluate(() => {
    let n = 0, err = '';
    const sizes = [100 * 1024, 16 * 1024, 1024, 256];
    for (const sz of sizes) {
      for (let i = 0; i < 6000; i++) {
        try { localStorage.setItem('__junk_' + (n++), new Array(sz + 1).join('x')); }
        catch (e) { err = (e && (e.name + ': ' + e.message)) || 'err'; break; }
      }
    }
    let canWrite32 = true;
    try { localStorage.setItem('__probe_small', new Array(33).join('y')); }
    catch (e) { canWrite32 = false; err = (e && (e.name + ': ' + e.message)) || err; }
    return { n, err, canWrite32 };
  });
  // 埋点：分别记录 save() 真正落盘的成败，以及 toast 的每一次变化（而不是只看最后一帧）
  await p3.evaluate(() => {
    window.__writes = []; window.__toasts = [];
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      try { orig(k, v); window.__writes.push({ k: String(k), ok: true }); }
      catch (e) { window.__writes.push({ k: String(k), ok: false, err: e.name }); throw e; }
    };
    const t = document.getElementById('toast');
    new MutationObserver(() => {
      const x = (t.textContent || '').trim();
      if (x && window.__toasts[window.__toasts.length - 1] !== x) window.__toasts.push(x);
    }).observe(t, { childList: true, characterData: true, subtree: true });
  });
  const beforeQuota = await storeGet(p3, 'cet6_p1_state_v1_9301');
  const kq = cur(l3);
  l3.promptReply = '5';
  await p3.locator('#floorBtn').click().catch(() => { });
  await p3.waitForTimeout(900);
  const quotaToast = await toastText(p3);
  const quotaErrs = since(l3, kq).errors;
  const afterQuota = await storeGet(p3, 'cet6_p1_state_v1_9301');
  const writes = await p3.evaluate(() => window.__writes || []);
  const toasts = await p3.evaluate(() => window.__toasts || []);
  const stateWrite = writes.filter(w => /cet6_p1_state_v1_9301/.test(w.k));
  const appAlive = await p3.evaluate(() => { try { document.querySelector('nav button[data-p="stat"]').click(); return true; } catch (e) { return false; } });
  const warnShown = toasts.some(x => /保存失败/.test(x));
  const memoryKeepsFloor = await p3.evaluate(() => {
    const t = document.getElementById('todayStatus');
    return !!t && /忙日打卡/.test(t.textContent || '');
  });
  P('storage', {
    name: '存储配额耗尽时 save()', filled: fill.n, fillErr: fill.err, canWrite32: fill.canWrite32,
    toast: quotaToast, toasts, caught: /保存失败/.test(quotaToast), warnToastShown: warnShown,
    saveWriteFailed: stateWrite.some(w => !w.ok), writeLog: stateWrite, errors: quotaErrs,
    oldStateIntact: beforeQuota === afterQuota, appAlive, memoryKeepsFloor,
  });
  log('  · 填充 ' + fill.n + ' 块后配额报错=' + JSON.stringify(fill.err) + '；连 32B 都写不进=' + (fill.canWrite32 === false) +
    '\n     setItem 埋点（state 键）=' + JSON.stringify(stateWrite) +
    '\n     toast 序列=' + JSON.stringify(toasts) + ' → 最终可见=' + JSON.stringify(quotaToast) +
    '\n     出过"保存失败"提示=' + warnShown + '；页面报错=' + quotaErrs.length +
    '；存档字节未变=' + (beforeQuota === afterQuota) + '；界面仍显示打卡成功=' + memoryKeepsFloor + '；页面可交互=' + appAlive);
  await shot(p3, 'storage-quota', false);
  await p3.evaluate(() => { for (const k of Object.keys(localStorage)) { if (k.indexOf('__junk_') === 0 || k === '__probe_small') { try { localStorage.removeItem(k); } catch (e) { } } } });

  // 3.2 损坏的 localStorage 值 → loadState 应回退 newState
  const corruptCases = [
    ['非 JSON 字符串', 'not json {{{'],
    ['JSON 但无 version', '{"history":{}}'],
    ['半截 JSON', '{"version":1,"history":{"20'],
    ['空字符串', ''],
  ];
  for (const [cn, cv] of corruptCases) {
    await p3.evaluate((v) => localStorage.setItem('cet6_p1_state_v1_9302', v), cv);
    await p3.evaluate(() => localStorage.setItem('cet6_user', '9302'));
    const k = cur(l3);
    await p3.reload({ waitUntil: 'load' });
    await p3.waitForTimeout(600);
    const errs = since(l3, k).errors;
    const cards = await planCards(p3).catch(() => -1);
    await p3.locator('nav button[data-p="wrong"]').click().catch(() => { });
    await p3.waitForTimeout(200);
    const wrongEmpty = await p3.evaluate(() => /错题本还是空的|暂无/.test((document.getElementById('allWrongList') || {}).textContent || ''));
    P('storage', { name: 'loadState 遇到 ' + cn, value: cv.slice(0, 40), errors: errs, cards, freshState: cards >= 1, wrongEmpty });
    log('  · localStorage=' + JSON.stringify(cv.slice(0, 24)) + ' → 报错=' + errs.length + ' 今日卡片=' + cards + ' 错题本为空兜底=' + wrongEmpty);
  }

  // 3.3 localStorage 对象本身不可用（隐私模式 / 站点数据被拦）
  {
    const { ctx: c3b, page: p3b, logs: l3b } = await newCtx(browser, 'storage-blocked');
    await c3b.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: storage blocked'); } });
    });
    await p3b.goto(URL, { waitUntil: 'load' });
    await p3b.waitForTimeout(800);
    const errs = l3b.pageerror;
    const bodyTxt = (await p3b.evaluate(() => document.body ? document.body.textContent : '')).trim();
    const appHtml = await p3b.evaluate(() => (document.getElementById('app') || { children: [] }).children.length);
    P('storage', {
      name: 'localStorage 访问即抛异常（隐私模式/站点数据被禁止）',
      errors: errs.map(e => e.slice(0, 200)), bodyTextLen: bodyTxt.length, appChildren: appHtml,
      blankScreen: appHtml <= 1 && bodyTxt.length < 40,
    });
    log('  · localStorage getter 抛异常 → 页面报错=' + errs.length + ' 可见文本长度=' + bodyTxt.length +
      ' #app 子节点=' + appHtml + ' 白屏=' + (appHtml <= 1 && bodyTxt.length < 40));
    if (errs.length) log('        ⛔ ' + errs[0].slice(0, 160));
    await shot(p3b, 'storage-blocked', false);
    await c3b.close();
  }

  // 3.4 从 localStorage 读到的 null 错题条目（loadState 迁移路径）
  {
    await p3.evaluate(() => localStorage.setItem('cet6_user', '9303'));
    await p3.evaluate((v) => localStorage.setItem('cet6_p1_state_v1_9303', v), JSON.stringify({
      version: 1, history: { [TODAY]: { minutes: 7, done: true } }, papers: {}, wrongbook: { [IDS.listening]: null },
    }));
    const k = cur(l3);
    await p3.reload({ waitUntil: 'load' });
    await p3.waitForTimeout(600);
    const errs = since(l3, k).errors;
    const cards = await planCards(p3).catch(() => -1);
    const lost = await p3.evaluate((t) => {
      try { const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9303')); return { historyKeys: Object.keys(st.history || {}), todayMin: (st.history || {})[t] ? st.history[t].minutes : null }; }
      catch (e) { return { err: e.message }; }
    }, TODAY);
    P('storage', {
      name: 'localStorage 中 wrongbook[qid]=null（loadState 迁移路径）',
      errors: errs.map(e => e.slice(0, 160)), cards, storedStillThere: lost,
      note: 'loadState 迁移块在 try 内，赋值 null.ease 抛错 → 整体回退 newState（内存中数据被静默清空）',
    });
    log('  · wrongbook[qid]=null 从 localStorage 载入 → 报错=' + errs.length + ' 今日卡片=' + cards +
      ' 内存状态被重置（存档虽是旧的，界面按全新状态渲染）');
  }
  await c3.close();

  /* ======================================================================
     ④ 导出 / 导入安全
     ====================================================================== */
  log('\n=========== ④ 导出/导入安全 ===========');
  const { ctx: c4, page: p4, logs: l4 } = await newCtx(browser, 'export');
  await boot(p4, '9401', goodState());
  // 导出按钮只存在于备份页（其他页签 display:none），点击前必须先切过去，否则 click() 会一直等可见性
  await p4.locator('nav button[data-p="backup"]').click();
  await p4.waitForSelector('#exportBtn', { state: 'visible' });

  // 4.1 导出 JSON
  let dl = null;
  try {
    const [d] = await Promise.all([p4.waitForEvent('download', { timeout: 15000 }), p4.locator('#exportBtn').click()]);
    dl = d;
    const fn = dl.suggestedFilename();
    const fp = await dl.path();
    const content = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(content);
    P('exp', {
      name: '导出备份 JSON', filename: fn,
      filenameOk: /^cet6-backup-\d{4}-\d{2}-\d{2}\.json$/.test(fn),
      pathTraversalRisk: /[\\/]|\.\./.test(fn), bytes: content.length,
      keys: Object.keys(parsed), hasVersion: !!parsed.version, hasHistory: !!parsed.history,
    });
    log('  · 导出 JSON：' + fn + '（' + content.length + 'B，顶层字段 ' + Object.keys(parsed).join(',') + '）' +
      ' 命名合规=' + /^cet6-backup-\d{4}-\d{2}-\d{2}\.json$/.test(fn) + ' 路径穿越风险=' + /[\\/]|\.\./.test(fn));
  } catch (e) { log('  · 导出 JSON 失败：' + e.message); P('exp', { name: '导出备份 JSON', error: e.message }); }

  // 4.2 导出 CSV：字段转义 + 公式注入
  const QID_A = IDS.reading, QID_B = IDS.listening;
  const FORMULA = {
    lastAnswer: '=1+1',
    csvField: 'a,"b"\nc',
    due: '=cmd|\'/c calc\'!A1',
    wrongCount: '@SUM(A1)',
  };
  await importObj(p4, goodState({
    wrongbook: {
      [QID_A]: { addedAt: TODAY, box: 0, wrongCount: FORMULA.wrongCount, due: FORMULA.due, ease: 2.5, iv: 1, streak: 0 },
      [QID_B]: { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 },
    },
    papers: {
      [QID_A]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: FORMULA.lastAnswer },
      [QID_B]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: FORMULA.csvField },
    },
  }));
  await p4.waitForTimeout(500);
  await p4.locator('nav button[data-p="backup"]').click();
  await p4.waitForSelector('#wrongCsvBtn', { state: 'visible' });
  try {
    const [d2] = await Promise.all([p4.waitForEvent('download', { timeout: 15000 }), p4.locator('#wrongCsvBtn').click()]);
    const csvRaw = fs.readFileSync(await d2.path(), 'utf8');
    const csv = csvRaw.replace(/^\uFEFF/, '');
    fs.writeFileSync(path.join(DOCS, 'security-csv-sample.csv'), csv, 'utf8');
    const rows = parseCSV(csv);
    const head = rows[0];
    const rowA = rows.find(r => r[0] === '2015-06-1' && r[1] === String(46)) || rows[1];
    const rowB = rows.find(r => r[0] === '2015-06-1' && r[1] === String(1)) || rows[2];
    const rec = P('exp', {
      name: '导出错题 CSV', filename: d2.suggestedFilename(), headerOk: head.length === 10 && head[0] === '卷号',
      rows: rows.length, csvBytes: csv.length,
      hasBOM: csvRaw.charCodeAt(0) === 0xFEFF, hasCRLF: /\r\n/.test(csvRaw),
      formula_lastAnswer_raw: rowA && rowA[4], formula_due_raw: rowA && rowA[8], formula_wrongCount_raw: rowA && rowA[7],
      escalation_quoteCommaNewline_roundTrip: rowB && rowB[4], expectedField: FORMULA.csvField,
      csvInjectionRisk: !!(rowA && (/^[=+\-@]/.test(rowA[4] || '') || /^[=+\-@]/.test(rowA[8] || '') || /^[=+\-@]/.test(rowA[7] || ''))),
      csvFromUserInput: true,
    });
    log('  · 导出 CSV：' + d2.suggestedFilename() + ' 行数=' + rows.length + ' 表头OK=' + rec.headerOk +
      '\n      字段转义（含逗号/引号/换行）往返一致=' + (rec.escalation_quoteCommaNewline_roundTrip === FORMULA.csvField) +
      '\n      公式前缀字段未加防护 → CSV 公式注入风险=' + rec.csvInjectionRisk +
      '（lastAnswer=' + JSON.stringify(rec.formula_lastAnswer_raw) + ' due=' + JSON.stringify(rec.formula_due_raw) + ' wrongCount=' + JSON.stringify(rec.formula_wrongCount_raw) + '）');
  } catch (e) { log('  · 导出 CSV 失败：' + e.message); P('exp', { name: '导出错题 CSV', error: e.message }); }

  // 4.3 非 JSON 文件导入（accept 仅为 UI 过滤，不是校验）
  await importObj(p4, goodState());
  await p4.waitForTimeout(400);
  for (const c of [
    { n: '文本 .txt', f: 'evil.txt', m: 'text/plain', b: 'not a backup at all' },
    { n: 'HTML 文件', f: 'evil.html', m: 'text/html', b: '<html><body>hi</body></html>' },
    { n: '二进制 .png', f: 'evil.png', m: 'image/png', b: '\x89PNG\r\n\x1a\n\x00\x01\x02' },
    { n: '合法 JSON 但非备份结构', f: 'evil.json', m: 'application/json', b: '{"a":1}' },
  ]) {
    const k = cur(l4);
    await importRaw(p4, c.b, c.f, c.m);
    const t = await toastText(p4);
    const errs = since(l4, k).errors;
    P('exp', { name: '导入非备份文件：' + c.n, file: c.f, mime: c.m, toast: t, rejected: /导入失败/.test(t), errors: errs });
    log('  · 导入 ' + c.f + '（' + c.m + '）→ toast=' + JSON.stringify(t) + ' 拒绝=' + /导入失败/.test(t) + ' 报错=' + errs.length);
  }

  // 4.4 导入的数据隔离（只影响当前学习编号）
  await boot(p4, '9402', goodState({ __isolation: 'B-ORIGINAL' }));
  await p4.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9402'));
    localStorage.setItem('cet6_p1_state_v1_9403', JSON.stringify({ version: 1, history: {}, papers: {}, wrongbook: {}, __isolation: 'C-UNTOUCHED' }));
  });
  const keysBefore = await p4.evaluate(() => Object.keys(localStorage).slice().sort());
  await importObj(p4, goodState({ __isolation: 'IMPORTED-INTO-9402' }));
  await p4.waitForTimeout(500);
  const a = await storeGet(p4, 'cet6_p1_state_v1_9402');
  const b = await storeGet(p4, 'cet6_p1_state_v1_9403');
  const keysAfter = await p4.evaluate(() => Object.keys(localStorage).slice().sort());
  const rec4 = P('exp', {
    name: '导入数据隔离', aHasImported: !!(a && a.indexOf('IMPORTED-INTO-9402') >= 0),
    otherUserUntouched: !!(b && b.indexOf('C-UNTOUCHED') >= 0),
    newKeys: keysAfter.filter(k => keysBefore.indexOf(k) < 0),
  });
  log('  · 导入隔离：当前 9402 写入导入数据=' + rec4.aHasImported + ' 另一编号 9403 数据未被改动=' + rec4.otherUserUntouched +
    ' 新增存储键=' + JSON.stringify(rec4.newKeys));
  await c4.close();

  /* ======================================================================
     ⑤ 控制台零报错（完整用户旅程）
     ====================================================================== */
  log('\n=========== ⑤ 控制台零报错 · 完整旅程 ===========');
  const { ctx: c5, page: p5, logs: l5 } = await newCtx(browser, 'journey');
  const steps = [];
  const mark = (n, ok, extra) => { steps.push({ step: n, ok, detail: extra || '' }); log('  · ' + (ok ? '✓' : '✗') + ' ' + n + (extra ? ' | ' + extra : '')); };

  await p5.goto(URL, { waitUntil: 'load' });
  await p5.waitForSelector('#loginMask', { timeout: 30000 });
  mark('打开页面显示登录层', true, '');
  await p5.locator('#phoneInput').fill('9501');
  await p5.locator('#loginBtn').click().catch(() => { });
  await p5.waitForSelector('#planList .card', { timeout: 30000 });
  mark('登录 9501 并生成今日清单', true, (await planCards(p5)) + ' 组');

  // 选一个选项数 ≤60 的客观题组
  // 按需加载：下列逻辑要遍历 window.CET6_BANKS 全库题目，先把 meta.order 的卷全部注入
  await ensureAllPapers(p5);
  const target = await p5.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9501'));
    const banks = window.CET6_BANKS || [];
    const findQ = id => { for (const b of banks) for (const q of b.questions) if (q.id === id) return q; return null; };
    const items = (st.plan && st.plan.items) || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.qids || !it.qids.length || it.type === 'writing' || it.type === 'translation') continue;
      let opts = 0, bad = false;
      for (const id of it.qids) {
        const q = findQ(id); if (!q) { bad = true; break; }
        if (q.type === 'match') { const pp = banks.find(b => b.questions.some(x => x.id === id)); opts += (pp && pp.matchParagraphs ? pp.matchParagraphs.length : 0); }
        else opts += (q.options || []).length;
      }
      if (!bad && opts > 0 && opts <= 60) return { idx: i, type: it.type, n: it.qids.length, opts };
    }
    return null;
  });
  if (target) {
    await p5.locator('#planList .card button').nth(target.idx).click();
    await p5.waitForTimeout(600);
    mark('开始一组题（' + target.type + ' ' + target.n + ' 题）', (await p5.locator('.opt').count()) > 0, '选项按钮 ' + target.opts);
    const n = await p5.locator('.opt').count();
    for (let i = 0; i < n; i++) await p5.locator('.opt').nth(i).click().catch(() => { });
    await p5.waitForTimeout(300);
    await p5.locator('#groupSubmit').click().catch(() => { });
    await p5.waitForTimeout(800);
    const ana = await p5.locator('.analysis').count();
    mark('提交判分并显示解析', ana > 0, '解析块 ' + ana);
    await shot(p5, 'journey-judged', true);
    await p5.locator('#groupDone').click().catch(() => { });
    await p5.waitForTimeout(500);
    mark('返回今日', (await p5.locator('#page-today').isVisible()), '');
  } else {
    mark('开始一组题', false, '未找到可作答的客观题组（跳过）');
  }
  for (const pg of ['wrong', 'stat', 'backup', 'today']) {
    await p5.locator('nav button[data-p="' + pg + '"]').click().catch(() => { });
    await p5.waitForTimeout(350);
    mark('切换页签 ' + pg, true, '');
  }
  // 导出（#exportBtn 只在备份页可见，先切过去）
  await p5.locator('nav button[data-p="backup"]').click().catch(() => { });
  await p5.waitForSelector('#exportBtn', { state: 'visible' }).catch(() => { });
  try {
    const [d] = await Promise.all([p5.waitForEvent('download', { timeout: 15000 }), p5.locator('#exportBtn').click()]);
    const jraw = fs.readFileSync(await d.path(), 'utf8');
    mark('备份页导出 JSON', /^cet6-backup-\d{4}-\d{2}-\d{2}\.json$/.test(d.suggestedFilename()) && !!JSON.parse(jraw).version,
      d.suggestedFilename() + ' ' + jraw.length + 'B');
  } catch (e) { mark('备份页导出 JSON', false, e.message.slice(0, 80)); }
  // 深色模式
  await p5.locator('#themeBtn').click(); await p5.waitForTimeout(250);
  const dark = await p5.evaluate(() => document.body.classList.contains('dark'));
  const themeLs = await storeGet(p5, 'cet6_theme');
  mark('切换深色模式', dark && themeLs === '1', 'body.dark=' + dark + ' cet6_theme=' + themeLs);
  await shot(p5, 'journey-dark', true);
  await p5.locator('#themeBtn').click(); await p5.waitForTimeout(200);
  // 切换用户
  l5.promptReply = '9502';
  await p5.locator('#userChip').click().catch(() => { });
  await p5.waitForSelector('#planList .card', { timeout: 20000 });
  await p5.waitForTimeout(700);
  const chip = await p5.evaluate(() => (document.getElementById('userChip') || {}).textContent || '');
  mark('切换用户到 9502', /9502/.test(chip), 'userChip=' + JSON.stringify(chip));
  await p5.locator('nav button[data-p="stat"]').click().catch(() => { });
  await p5.waitForTimeout(400);
  await shot(p5, 'journey-final', true);

  const jErrs = l5.pageerror;
  const jConsole = l5.console;
  const consolesByType = {};
  jConsole.forEach(m => { consolesByType[m.type] = (consolesByType[m.type] || 0) + 1; });
  const errConsoles = jConsole.filter(m => m.type === 'error' || m.type === 'warning');
  const EXTERNAL = /lazynote|net::|Failed to load resource/i;
  P('journey', {
    steps, pageErrors: jErrs, consoleCounts: consolesByType,
    consoleProblems: errConsoles.map(m => ({ type: m.type, text: m.text.slice(0, 220) })),
    consoleProblemsAppRelated: errConsoles.filter(m => !EXTERNAL.test(m.text)).map(m => ({ type: m.type, text: m.text.slice(0, 220) })),
    consoleProblemsExternal: errConsoles.filter(m => EXTERNAL.test(m.text)).length,
    dialogs: l5.dialog,
  });
  log('  · 旅程步骤 ' + steps.filter(s => s.ok).length + '/' + steps.length + ' 通过');
  log('  · 未捕获异常 ' + jErrs.length + ' 条；console 计数 ' + JSON.stringify(consolesByType));
  if (jErrs.length) jErrs.forEach(e => log('      ⛔ pageerror: ' + e.slice(0, 200)));
  /* 证据行必须用中性前缀。
     run_all.js 的行解析器约定"行首的 fail / error / ✗ / ❌ 就是判定失败"，
     原写法 `      [error] Failed to load resource …` 会被它数成 2 条 FAIL ——
     实测本脚本自己判 11 ok / 0 fail，进了 runner 却显示 11 ok / 2 fail（假红）。
     改成 `      · [error] …` 后仍是同样的证据，但不会被误读成判定。 */
  errConsoles.forEach(m => log('      · [' + m.type + '] ' + m.text.slice(0, 200)));

  /* ======================================================================
     ⑥ file:// 下的 Service Worker 行为
     ====================================================================== */
  log('\n=========== ⑥ file:// 下 SW 行为 ===========');
  const swInfo = await p5.evaluate(async () => {
    let regs = -1, err = '';
    try { regs = (await navigator.serviceWorker.getRegistrations()).length; } catch (e) { err = e.message; }
    return {
      protocol: location.protocol, hasServiceWorker: 'serviceWorker' in navigator,
      registrations: regs, err,
      controller: !!navigator.serviceWorker.controller,
    };
  });
  const swSrc = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
  P('sw', {
    ...swInfo, swFileBytes: swSrc.length,
    guardInHtml: /location\.protocol === 'https:'/.test(fs.readFileSync(INDEX, 'utf8')),
    errors: jErrs.filter(e => /serviceworker|sw\.js/i.test(e)),
  });
  log('  · location.protocol=' + swInfo.protocol + ' 支持 SW=' + swInfo.hasServiceWorker +
    ' 已注册实例=' + swInfo.registrations + ' controller=' + swInfo.controller +
    '\n  · index.html 注册语句有 https 协议守卫=' + /location\.protocol === 'https:'/.test(fs.readFileSync(INDEX, 'utf8')) +
    ' sw.js 存在（' + swSrc.length + 'B）');
  if (swInfo.registrations > 0) log('      ⚠ file:// 下竟然注册了 ' + swInfo.registrations + ' 个 SW');
  await shot(p5, 'sw-file-protocol', false);
  await c5.close();

  await browser.close();

  /* ---------------- 汇总输出 ---------------- */
  const allPageErrors = [];
  R.dirty.forEach(d => { d.uniqueErrors.forEach(e => allPageErrors.push({ from: d.name, err: e })); });
  R.storage.forEach(s => (s.errors || []).forEach(e => allPageErrors.push({ from: s.name, err: e })));
  const xssExecuted = R.xss.filter(x => x.executed);
  const corruptCrashes = R.dirty.filter(d => d.errsOnImport.length + d.errsAfterNav.length + d.errsAfterReload.length > 0);

  log('\n=========== 汇总 ===========');
  const xssInjected = R.xss.filter(x => x.injected === true);
  const envLimited = R.dirty.filter(d => d.envLimited);

  /* ---------------- 明确判定（防空绿） ----------------
     本脚本此前只输出 '  · xxx' 项目符号与计数，从不给出 pass/fail，也不设置退出码——
     结果是它跑满 7 分钟、结论全对，机器却无从消费（回归 runner 只能判 NO-ASSERT）。
     这里把每条判定落成 ok/FAIL 断言，并让失败体现在退出码上。               */
  let nOk = 0, nFail = 0;
  const chk = (name, cond, detail) => {
    if (cond) { nOk++; log('ok   ' + name + (detail ? ' | ' + detail : '')); }
    else { nFail++; log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
  };

  log('XSS 用例 ' + R.xss.length + ' 个：payload 被当 HTML 解析 ' + xssInjected.length + ' 个，其中真正执行 ' + xssExecuted.length + ' 个');
  log('    （判定口径：目标容器内出现真实 <img src=x>/<svg> 元素 = 注入成立；window.__pwned 递增 = 代码执行）');
  xssInjected.forEach(x => log('   ⛔ ' + x.name + ' | ' + (x.targets ? '目标容器 ' + x.targets.join('+') + ' | ' : '') + x.sink));
  log('脏数据用例 ' + R.dirty.length + ' 个，其中产生未捕获异常 ' + corruptCrashes.length + ' 个');
  corruptCrashes.forEach(d => log('   ⛔ ' + d.name + ' → ' + d.uniqueErrors[0]));
  log('回归明细见 docs/security-regression-*.txt');

  const expErrs = R.exp.filter(e => e.error);
  const jr = R.journey[0];
  const storageErrs = R.storage.reduce((a, s) => a + (s.errors || []).length, 0);

  chk('脚本完整跑完（无中断）', !R.fatal, R.fatal || '');
  chk('XSS 用例覆盖数 ≥ 20（套件未缩水）', R.xss.length >= 20, '实际 ' + R.xss.length + ' 个');
  chk('XSS：无 payload 被当 HTML 解析', xssInjected.length === 0, xssInjected.map(x => x.name).join(', ') || '0 个');
  chk('XSS：无 payload 真正执行', xssExecuted.length === 0, xssExecuted.map(x => x.name).join(', ') || '0 个');
  chk('脏数据用例覆盖数 ≥ 18（套件未缩水）', R.dirty.length >= 18, '实际 ' + R.dirty.length + ' 个');
  chk('脏数据：无未捕获异常', corruptCrashes.length === 0, corruptCrashes.map(d => d.name).join(', ') || '0 个');
  chk('脏数据：无渲染进程崩溃（环境限制）', envLimited.length === 0, envLimited.map(d => d.name).join(', ') || '0 个');
  chk('导出：无错误', expErrs.length === 0, expErrs.map(e => e.name).join(', ') || '0 个');
  chk('localStorage 边界：无未捕获异常', storageErrs === 0, '用例 ' + R.storage.length + ' 个 / 异常 ' + storageErrs + ' 个');
  chk('完整旅程：无 pageerror', jr ? (jr.pageErrors || []).length === 0 : false,
    jr ? ((jr.pageErrors || []).slice(0, 2).join(' | ') || '0 个') : '旅程未执行');
  chk('完整旅程：全部步骤通过', jr ? jr.steps.every(s => s.ok) : false,
    jr ? (jr.steps.filter(s => !s.ok).map(s => s.name).join(', ') || ('共 ' + jr.steps.length + ' 步全通过')) : '旅程未执行');
  chk('完整旅程：应用自身 console 错误为 0（第三方/CDN 噪声已剔除）',
    jr ? (jr.consoleProblemsAppRelated || []).length === 0 : false,
    jr ? (((jr.consoleProblemsAppRelated || []).slice(0, 2).map(x => x.text).join(' | ')) ||
      ('0 个；第三方资源噪声 ' + (jr.consoleProblemsExternal || 0) + ' 条已剔除')) : '旅程未执行');

  R.summary = {
    xssCases: R.xss.length, xssInjected: xssInjected.map(x => x.name), xssExecuted: xssExecuted.map(x => x.name),
    exportErrors: R.exp.filter(e => e.error).map(e => ({ name: e.name, error: e.error })),
    journeySteps: R.journey[0] ? R.journey[0].steps.filter(x => x.ok).length + '/' + R.journey[0].steps.length : '',
    consoleCounts: R.journey[0] ? R.journey[0].consoleCounts : {},
    dirtyCases: R.dirty.length, dirtyWithUncaught: corruptCrashes.map(d => ({ name: d.name, err: d.uniqueErrors[0] })),
    journeyPageErrors: R.journey[0] ? R.journey[0].pageErrors : [],
    envLimitedCases: envLimited.map(d => d.name),
    assertions: { ok: nOk, fail: nFail },
    finishedAt: new Date().toISOString(),
  };
  log('\n===== 安全审计判定: ' + nOk + ' ok / ' + nFail + ' fail =====');
  process.exitCode = nFail ? 1 : 0;
  } catch (e) {
    log('\n‼ 审计脚本中断（已保留此前结果）：' + (e && e.stack ? e.stack : e));
    R.fatal = String((e && e.message) || e);
    try { await browser.close(); } catch (e2) { }      // 必须关，否则 node 进程不退出、日志文件被占
  }
  if (!R.summary) R.summary = { interrupted: true, error: R.fatal || 'unknown' };
  // 中断必须表现为 FAIL + 非零退出码：否则"跑了但没验完"会被误当成通过
  if (R.fatal) { log('FAIL 脚本中断：' + R.fatal); process.exitCode = 1; }
  fs.writeFileSync(path.join(DOCS, 'security-audit-log.txt'), LINES.join('\n'), 'utf8');
  fs.writeFileSync(path.join(DOCS, 'security-audit-result.json'), JSON.stringify(R, null, 2), 'utf8');
  log('已写出：docs/security-audit-log.txt / docs/security-audit-result.json');
})();

/* 极简 RFC4180 CSV 解析 */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
