'use strict';
/* ============================================================================
   CET6 打卡应用 · 复测轮 A1：XSS 注入复测（20 主用例 + 补充用例 + 阴性对照）
   被测：D:\CET6\app\index.html + core.js（只读，不做任何修改）
   运行：cd D:\CET6\scripts ; node retest_xss.js
   产物：docs/retest-security-xss-*.png / docs/retest-xss-result.json / docs/retest-xss-log.txt

   判定口径：
     executed = window.__pwned 递增      → 代码真的执行了（最严重）
     injected = 容器内出现真实 <img src=x>/<svg>/<script> 元素 → payload 被当 HTML 解析
     两者都为 0 才算通过。
   阴性对照（control）：先证明探针是活的——把同一 payload 用 innerHTML 裸插一次，
     必须 executed=1，否则"0 执行"是假阴性。
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, fileUrl, ensurePaper, planVersion } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const INDEX = path.join(APP, 'index.html');
const URL = fileUrl(INDEX);
const DOCS = path.join(ROOT, 'docs');

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const pad = n => (n < 10 ? '0' + n : '' + n);
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
const UID = '9203';
const SKEY = 'cet6_p1_state_v1_' + UID;
const QID = '2026-06-1-r-46';   // 题库真实存在的题
const GHOST = '9999-99-9-r-999';
const PAPER = '2026-06-1';
/* 注入 plan 的 v 必须等于当前 PLAN_VERSION（原来写死 v:3，清单会被丢弃重算） */
const PLANV = planVersion();

const R = { meta: {}, control: null, main: [], extra: [], bank: [], cases: [], summary: {} };
/* 2026-11-05：本脚本此前只 log 不判定，run_all 判它 0 断言 → NO-ASSERT（假绿）。
   现在每条结论都落成一条断言，既堵住假绿，也让"0 执行/0 注入"变成可被闸门检查的结论。 */
function t(name, group, pass, detail) {
  R.cases.push({ name, group, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`);
  return pass;
}
const PL_KINDS = ['img', 'svg', 'attr', 'sq', 'script'];
/* tag = 探针唯一标识，便于从 outerHTML 回溯是哪个用例漏出来的 */
const mkPL = {
  img: t => `<img src=x onerror="__probe('${t}')">`,
  svg: t => `<svg onload="__probe('${t}')"></svg>`,
  attr: t => `"><img src=x onerror="__probe('${t}')">`,
  sq: t => `'><img src=x onerror="__probe('${t}')">`,
  script: t => `<script>__probe('${t}')</script>`,
  rcdata: t => `</textarea><img src=x onerror="__probe('${t}')">`,
  compact: t => `<svg onload=__probe('${t}')>`,   // 给 24 字符截断字段用
};

const CONTAINERS = ['#planList', '#statGrid', '#heatmap', '#dueList', '#allWrongList',
  '#accTable', '#ptTable', '#estCard', '#bankInfo', '#todayMinutes', '#backupHint',
  '#checkBox', '#quizBody', '.point-train'];

/* ---------------- 浏览器上下文 ---------------- */
async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 }, acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.__pwned = 0; window.__pwnedTags = [];
    window.__probe = function (t) { window.__pwned++; window.__pwnedTags.push(t); };
  });
  const page = await ctx.newPage();
  const logs = { console: [], pageerror: [], dialog: [] };
  page.on('console', m => logs.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.pageerror.push(String((e && e.message) || e)));
  page.on('dialog', async dl => {
    logs.dialog.push({ type: dl.type(), message: dl.message() });
    try { await dl.accept(dl.type() === 'prompt' ? '10' : ''); } catch (e) { }
  });
  return { ctx, page, logs };
}

async function boot(page, stateObj, uid) {
  uid = uid || UID;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ id, st }) => {
    try { localStorage.setItem('cet6_user', id); } catch (e) { }
    try {
      localStorage.removeItem('cet6_p1_state_v1_' + id);
      if (st !== null) localStorage.setItem('cet6_p1_state_v1_' + id, st);
    } catch (e) { }
  }, { id: uid, st: stateObj === undefined || stateObj === null ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); }
  catch (e) { log('   ⚠ boot 后 20s 内今日清单无卡片：' + String(e.message).split('\n')[0]); }
  await page.waitForTimeout(250);
}

/* ---------------- 探测 ---------------- */
function detect(page) {
  return page.evaluate((sels) => {
    const bad = [];
    let evidence = '';
    sels.forEach(s => {
      let els = [];
      try { els = Array.from(document.querySelectorAll(s)); } catch (e) { return; }
      els.forEach(el => {
        const html = el.outerHTML || '';
        const im = el.querySelectorAll('img[src="x"]').length;
        const sv = el.querySelectorAll('svg').length;
        const sc = Array.from(el.querySelectorAll('script')).filter(x => /__probe/.test(x.textContent || '')).length;
        const bad2 = Array.from(el.querySelectorAll('*')).filter(x =>
          /onerror|onload/i.test(x.getAttribute('onerror') || '') || /onerror|onload/i.test(x.getAttribute('onload') || '')).length;
        if (im + sv + sc + bad2 > 0) bad.push({ sel: s, img: im, svg: sv, script: sc, onAttr: bad2 });
        if (!evidence && html.indexOf('__probe') >= 0) {
          const i = html.indexOf('__probe');
          evidence = html.slice(Math.max(0, i - 90), i + 90).replace(/\s+/g, ' ');
        }
      });
    });
    const docImgs = document.querySelectorAll('img[src="x"]').length;
    const docSvgs = document.querySelectorAll('svg').length;
    return {
      pwned: window.__pwned || 0,
      tags: (window.__pwnedTags || []).slice(),
      badContainers: bad,
      docImgs, docSvgs,
      evidence,
    };
  }, CONTAINERS);
}
const inj = r => r.badContainers.length + (r.docImgs > 0 || r.docSvgs > 0 ? 1 : 0);

/* 依次浏览各页签，累积最坏结果。注意：做题浮层 z-index 高于导航，直接派发 click 避免被遮挡 */
async function sweep(page) {
  const acc = { pwned: 0, tags: [], bad: [], evidence: '' };
  const collect = async (at) => {
    const r = await detect(page);
    acc.pwned = Math.max(acc.pwned, r.pwned);
    if (r.pwned) acc.tags = acc.tags.concat(r.tags);
    r.badContainers.forEach(x => acc.bad.push(Object.assign({ at }, x)));
    if (!acc.evidence && r.evidence) acc.evidence = r.evidence;
  };
  await collect('as-is');
  const opened = await page.evaluate(() => { const q = document.getElementById('quiz'); return !!(q && q.classList.contains('show')); });
  if (opened) {
    await page.evaluate(() => { const b = document.getElementById('quizBack'); if (b) b.click(); });
    await page.waitForTimeout(260);
  }
  for (const st of ['wrong', 'stat', 'backup', 'today']) {
    await page.evaluate(s => { const b = document.querySelector('nav button[data-p="' + s + '"]'); if (b) b.click(); }, st);
    await page.waitForTimeout(200);
    await collect(st);
  }
  return acc;
}

function baseState(extra) {
  return Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' }, extra || {});
}
function planWith(items) { return { date: TODAY, v: PLANV, items: items }; }
const P_READ = { key: 'new-reading-2026-06-1-46', type: 'reading', qids: [QID], paperId: PAPER, label: '仔细阅读·整篇 46-50', done: false, minutes: 0 };

/* ========================================================================== */
(async () => {
  try {
    const crypto = require('crypto');
    const hashOf = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    R.meta = {
      url: URL, browser: EXE, today: TODAY, node: process.version, startedAt: new Date().toISOString(),
      hashes: {
        'app/index.html': hashOf(INDEX),
        'app/core.js': hashOf(path.join(APP, 'core.js')),
        'app/sw.js': hashOf(path.join(APP, 'sw.js')),
        'app/manifest.json': hashOf(path.join(APP, 'manifest.json')),
      },
    };
    log('CET6 复测 A1 · XSS 注入复测  ' + R.meta.startedAt);
    log('页面：' + URL);
    log('浏览器：' + EXE);
    log('今日：' + TODAY + '  账号：' + UID + '  存档 key：' + SKEY + '\n');
    log('被测文件指纹（sha256）：');
    Object.keys(R.meta.hashes).forEach(k => log('   ' + k + '  ' + R.meta.hashes[k]));

    const browser = await chromium.launch({
      executablePath: EXE,
      args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'],
    });

    /* ---------- 0. 阴性对照：证明探针可用 ---------- */
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      const r = await page.evaluate(() => {
        window.__pwned = 0;
        const d = document.createElement('div');
        d.innerHTML = '<img src=x onerror="__probe(\'control\')">';
        document.body.appendChild(d);
        return new Promise(res => setTimeout(() => {
          const out = { pwned: window.__pwned, imgs: document.querySelectorAll('img[src="x"]').length };
          d.remove();
          res(out);
        }, 400));
      });
      R.control = { pwned: r.pwned, imgs: r.imgs, ok: r.pwned > 0 };
      log('【阴性对照】裸 innerHTML 插入同一 payload → __pwned=' + r.pwned + '，img[src=x]=' + r.imgs +
        '  → 探针' + (r.pwned > 0 ? '有效（0 执行结论可信）' : '※失效，后续 0 执行不可信※'));
      t('阴性对照：裸 innerHTML 会执行同一 payload（证明探针有效）', '对照', r.pwned > 0,
        '__pwned=' + r.pwned + ' img[src=x]=' + r.imgs);
      await page.screenshot({ path: path.join(DOCS, 'retest-security-control-harness.png') });
      await ctx.close();
    }

    /* ---------- 1. 20 个主用例：5 payload × 4 字段 ---------- */
    const FIELDS = [
      {
        id: 'history.minutes', sink: 'index.html:1100 heatmap title + :1115 statGrid「今日」分钟',
        build: P => baseState({ history: { [TODAY]: { minutes: P, done: false, floor: false, qCount: 3, right: 2, timed: 1, timedWithin: 1, timedSec: 60 } } }),
      },
      {
        id: 'papers.seen', sink: 'index.html:1124 accTable 做题数 + :1142 estCard 部分题数 + :1158 ptTable 做题数',
        build: P => baseState({ papers: { [QID]: { seen: P, right: 1, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: 'A' } } }),
      },
      {
        id: 'wrongbook.wrongCount', sink: 'index.html:986 wrongRow「错 N 次」',
        build: P => baseState({ wrongbook: { [QID]: { addedAt: TODAY, box: 0, wrongCount: P, due: TODAY, ease: 2.5, iv: 1, streak: 0 } } }),
      },
      {
        id: 'plan.items[].label', sink: 'index.html:502 planList 卡片标题（字符串字段，会穿过 normalizeState 进入 DOM）',
        build: P => baseState({ plan: planWith([Object.assign({}, P_READ, { label: P })]) }),
      },
    ];
    log('\n================ 1) 主用例（5 payload × 4 字段 = 20 例）================');
    let n = 0;
    for (const f of FIELDS) {
      for (const k of PL_KINDS) {
        n++;
        const tag = 'c' + n;
        const P = mkPL[k](tag);
        const { ctx, page, logs } = await newCtx(browser);
        await boot(page, f.build(P));
        const acc = await sweep(page);
        const executed = acc.pwned > 0;
        const injected = acc.bad.length > 0;
        const rec = {
          no: n, field: f.id, payloadKind: k, payload: P, sink: f.sink,
          executed, injected, pwned: acc.pwned, tags: acc.tags,
          badContainers: acc.bad, evidence: acc.evidence,
          consoleErr: logs.console.filter(m => m.type === 'error').map(m => m.text),
          pageErr: logs.pageerror.slice(),
        };
        R.main.push(rec);
        log(`  #${String(n).padStart(2)} ${f.id.padEnd(22)} ${k.padEnd(7)} executed=${executed} injected=${injected}` +
          (injected ? '  ← ' + JSON.stringify(acc.bad) : ''));
        if (n === 8) await page.screenshot({ path: path.join(DOCS, 'retest-security-xss-plan-label.png') });
        if (n === 3) await page.screenshot({ path: path.join(DOCS, 'retest-security-xss-wrongbook.png') });
        await ctx.close();
      }
    }

    /* ---------- 2. 补充用例：其余曾受影响注入点（每 payload 一个聚合上下文）---------- */
    log('\n================ 2) 补充用例（历史/统计/错题/草稿/登录/高亮/清单字段）================');
    const EXTRA_FIELDS = [
      {
        id: 'history.timed', sink: 'index.html:1118 statGrid 限时达标',
        build: P => baseState({ history: { [TODAY]: { minutes: 1, done: true, floor: false, qCount: 1, right: 1, timed: P, timedWithin: 1, timedSec: 60 } } }),
      },
      {
        id: 'papers.right', sink: 'index.html:1124 accTable 正确数',
        build: P => baseState({ papers: { [QID]: { seen: 1, right: P, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: 'A' } } }),
      },
      {
        id: 'wrongbook.due', sink: 'index.html:986 wrongRow「下次到期」（normalizeState 有日期白名单）',
        build: P => baseState({ wrongbook: { [QID]: { addedAt: TODAY, box: 0, wrongCount: 1, due: P, ease: 2.5, iv: 1, streak: 0 } } }),
      },
      {
        id: 'plan.items[].type', sink: 'index.html:501/502 图标首字 + 标签兜底 meta.zh',
        build: P => baseState({ plan: planWith([Object.assign({}, P_READ, { label: '', type: P.slice(0, 24) })]) }),
      },
      {
        id: 'plan.items[].paperId', sink: 'index.html:503 planList 副标题',
        build: P => baseState({ plan: planWith([Object.assign({}, P_READ, { paperId: P.slice(0, 24) })]) }),
      },
      {
        id: 'hl[pid]', sink: 'index.html:859 restoreHl（createTextNode 路径）', openQuiz: true,
        build: P => baseState({
          plan: planWith([Object.assign({}, P_READ, { qids: [QID], type: 'reading' })]),
          hl: { [`${PAPER}#reading#read0`]: [P.slice(0, 200), P.slice(0, 200)] },
        }),
      },
      {
        id: 'papers.lastAnswer', sink: 'index.html:1222 CSV「你的答案」列（csvEsc）',
        build: P => baseState({ papers: { [QID]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: P.slice(0, 40) } }, wrongbook: { [QID]: { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 } } }),
      },
    ];
    for (const f of EXTRA_FIELDS) {
      const tags = [];
      let executed = false, injected = 0, bad = [], ev = '';
      for (let i = 0; i < PL_KINDS.length; i++) {
        const k = PL_KINDS[i];
        const tag = 'x' + i;
        const P = mkPL[k](tag);
        const { ctx, page, logs } = await newCtx(browser);
        await boot(page, f.build(P));
        if (f.openQuiz) {   // 需要打开题组才会走到 restoreHl / renderGroup
          const ob = page.locator('#planList .card button').first();
          if (await ob.count()) { await ob.click(); }
          // 按需加载：等题目真正渲染出来，否则 restoreHl 根本没跑
          await page.waitForSelector('#quizBody .opt, #quizBody .passage', { timeout: 20000 }).catch(() => { });
          await page.waitForTimeout(250);
        }
        const acc = await sweep(page);
        if (acc.pwned > 0) { executed = true; tags.push({ kind: k, tags: acc.tags }); }
        if (acc.bad.length) { injected++; bad.push({ kind: k, bad: acc.bad }); }
        if (!ev && acc.evidence) ev = acc.evidence;
        if (k === 'img') await page.screenshot({ path: path.join(DOCS, 'retest-security-xss-extra-' + f.id.replace(/[^a-z0-9]/gi, '-') + '.png') });
        await ctx.close();
      }
      R.extra.push({ field: f.id, sink: f.sink, payloads: PL_KINDS.length, executed, executedDetail: tags, injectedKinds: injected, badDetail: bad, evidence: ev });
      log(`  ${f.id.padEnd(22)} 5 payload → executed=${executed} injected=${injected}`);
    }

    /* ---------- 3. 草稿（RCDATA 逃逸）专项：textarea 里的 </textarea><img> ---------- */
    log('\n================ 3) 草稿 RCDATA 逃逸专项（</textarea><img onerror>）================');
    {
      const P = mkPL.rcdata('essay');
      const st = baseState({
        plan: planWith([{ key: 'essay-x', type: 'writing', qids: [], paperId: PAPER, done: false, minutes: 0 }]),
        essays: { writing: { lastAt: TODAY, text: P }, translation: { lastAt: TODAY, text: P } },
      });
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, st);
      if (!await ensurePaper(page, PAPER)) throw new Error('卷 ' + PAPER + ' 未能加载，草稿逃逸用例无法进行');
      const btn = page.locator('#planList .card button').first();
      if (await btn.count()) { await btn.click(); }
      await page.waitForSelector('#essayTa', { timeout: 20000 }).catch(() => { });
      await page.waitForTimeout(200);
      const a = await detect(page);
      // 再用「踩分词自查」把 sample 派生文本渲染一次（miss.map(esc)）
      const ck = page.locator('#essayCheck');
      if (await ck.count()) { await ck.click(); await page.waitForTimeout(300); }
      const b = await detect(page);
      const executed = Math.max(a.pwned, b.pwned) > 0;
      const injected = a.badContainers.length + b.badContainers.length > 0;
      R.extra.push({
        field: 'essays.writing.text(</textarea>逃逸)', sink: 'index.html:687 草稿 textarea + :1039 essayCheck',
        payloads: 1, executed, injectedKinds: injected ? 1 : 0,
        badDetail: a.badContainers.concat(b.badContainers), evidence: a.evidence || b.evidence,
        textareaValHead: await page.evaluate(() => { const t = document.getElementById('essayTa'); return t ? String(t.value).slice(0, 60) : null; }),
      });
      log('  草稿跳出 textarea：executed=' + executed + ' injected=' + injected +
        '  textarea 内文本头=' + JSON.stringify(R.extra[R.extra.length - 1].textareaValHead));
      await page.screenshot({ path: path.join(DOCS, 'retest-security-xss-essay-draft.png') });
      await ctx.close();
    }

    /* ---------- 4. 登录编号（回归）---------- */
    log('\n================ 4) 登录学习编号注入（回归确认）================');
    for (const k of PL_KINDS) {
      const P = mkPL[k]('login');
      const { ctx, page, logs } = await newCtx(browser);
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
      await page.evaluate(v => { try { localStorage.setItem('cet6_user', v); } catch (e) { } }, P);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(500);
      const r = await detect(page);
      const mask = await page.evaluate(() => !!document.getElementById('loginMask'));
      const chip = await page.evaluate(() => { const c = document.getElementById('userChip'); return c ? c.textContent : null; });
      R.extra.push({ field: 'cet6_user(登录编号)', sink: 'index.html:368 /^\\d{4}$/.test(user) → showLogin()', payloadKind: k, payload: P, executed: r.pwned > 0, injectedKinds: r.badContainers.length ? 1 : 0, injected: r.badContainers.length > 0, loginMaskShown: mask, userChipText: chip, badDetail: r.badContainers });
      log('  ' + k.padEnd(7) + ' → 登录层出现=' + mask + ' injected=' + (r.badContainers.length > 0) + ' executed=' + (r.pwned > 0) + ' userChip=' + JSON.stringify(chip));
      if (k === 'img') await page.screenshot({ path: path.join(DOCS, 'retest-security-xss-login.png') });
      await ctx.close();
    }

    /* ---------- 5. 题库字段篡改（渲染层压力测试，找 esc() 遗漏）---------- */
    log('\n================ 5) 题库字段篡改 → 渲染层压力测试 ================');
    const BANK_CASES = [
      { id: 'q.stem', path: "b.questions.find(q=>q.id==='2026-06-1-r-46').stem", note: 'renderOneQ 题干' },
      { id: 'q.options[0]', path: "b.questions.find(q=>q.id==='2026-06-1-r-46').options[0]", note: '选项按钮文本' },
      { id: 'q.analysis', path: "b.questions.find(q=>q.id==='2026-06-1-r-46').analysis", note: '解析正文' },
      { id: 'q.points[0]', path: "b.questions.find(q=>q.id==='2026-06-1-r-46').points[0]", note: '考点标签（renderOneQ + ptTable + pointTrainBtn）' },
      { id: 'q.typeZh', path: "b.questions.find(q=>q.id==='2026-06-1-r-46').typeZh", note: 'wrongRow 题型' },
      { id: 'q.answer', path: "b.questions.find(q=>q.id==='2026-06-1-r-46').answer", note: '判分/CSV 正确答案' },
      { id: 'paper.id', path: "b.id", note: 'bankInfo + planList + quizProg' },
      { id: 'paper.matchIntro', path: "b.matchIntro", note: '匹配题引言' },
      { id: 'paper.matchParagraphs[0].text', path: "b.matchParagraphs[0].text", note: '匹配段落正文' },
      { id: 'paper.readingPassages.46', path: "b.readingPassages['46']", note: '阅读原文' },
      { id: 'paper.clozePassage', path: "b.clozePassage", note: '选词填空原文' },
      { id: 'paper.writing.prompt', path: "b.writing.prompt", note: '写作题面' },
      { id: 'paper.writing.sample', path: "b.writing.sample", note: '参考范文' },
    ];
    for (const c of BANK_CASES) {
      const P = mkPL.img('bank');
      const { ctx, page, logs } = await newCtx(browser);
      // 需要一个能把这些字段渲染出来的存档：plan 里放同卷的 reading / match / cloze / writing 条目
      const st = baseState({
        plan: planWith([
          Object.assign({}, P_READ, { qids: ['2026-06-1-r-46', '2026-06-1-r-47'], type: 'reading' }),
        ]),
        wrongbook: { [QID]: { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 } },
      });
      await boot(page, st);
      /* 按需加载：卷正文不在首屏 BANKS 里，不先注入目标卷，下面 find() 得到 undefined，
         13 例篡改全部 applied='no-paper' —— "0 执行 / 0 注入"是因为压根没篡改，属于假绿。 */
      if (!await ensurePaper(page, PAPER)) throw new Error('卷 ' + PAPER + ' 未能加载，题库篡改用例无法进行');
      const applied = await page.evaluate(({ p, v }) => {
        try {
          const b = (window.CET6_BANKS || []).find(x => x.id === '2026-06-1');
          if (!b) return 'no-paper';
          /* eslint-disable no-new-func */
          const setter = new Function('b', 'v', p + ' = v; return ' + p + ';');
          setter(b, v);
          return 'ok';
        } catch (e) { return 'ERR:' + e.message; }
      }, { p: c.path, v: P });
      // 触发渲染：题组 + 错题本 + 统计 + 备份页
      const b1 = page.locator('#planList .card button').first();
      if (await b1.count()) { await b1.click(); await page.waitForTimeout(350); }
      const a = await detect(page);
      await sweep(page);
      const b2 = await detect(page);
      // 备份页 bankInfo 渲染
      await page.evaluate(() => { const b = document.querySelector('nav button[data-p="backup"]'); if (b) b.click(); });
      await page.waitForTimeout(220);
      const c3 = await detect(page);
      const injected = a.badContainers.length + b2.badContainers.length + c3.badContainers.length > 0;
      const executed = Math.max(a.pwned, b2.pwned, c3.pwned) > 0;
      R.bank.push({
        id: c.id, path: c.path, note: c.note, applied, executed, injected,
        bad: a.badContainers.concat(b2.badContainers, c3.badContainers),
        evidence: a.evidence || b2.evidence || c3.evidence,
      });
      log('  ' + c.id.padEnd(32) + ' applied=' + applied + '  executed=' + executed + '  injected=' + injected +
        (injected ? ' ← ' + JSON.stringify(a.badContainers.concat(b2.badContainers, c3.badContainers)) : ''));
      if (c.id === 'q.stem') await page.screenshot({ path: path.join(DOCS, 'retest-security-bank-tamper-stem.png') });
      await ctx.close();
    }

    /* ---------- 汇总 ---------- */
    const mainExec = R.main.filter(x => x.executed).length;
    const mainInj = R.main.filter(x => x.injected).length;
    const extraExec = R.extra.filter(x => x.executed).length;
    const extraInj = R.extra.filter(x => x.injectedKinds > 0).length;
    const bankExec = R.bank.filter(x => x.executed).length;
    const bankInj = R.bank.filter(x => x.injected).length;
    const bankApplied = R.bank.filter(x => x.applied === 'ok').length;
    const pageErrs = R.main.filter(x => x.pageErr.length).map(x => ({ no: x.no, err: x.pageErr }));
    R.summary = {
      control: R.control, mainTotal: R.main.length, mainExecuted: mainExec, mainInjected: mainInj,
      extraTotal: R.extra.length, extraExecuted: extraExec, extraInjected: extraInj,
      bankTotal: R.bank.length, bankApplied, bankExecuted: bankExec, bankInjected: bankInj,
      pageErrors: pageErrs,
      pass: mainExec === 0 && mainInj === 0 && extraExec === 0 && extraInj === 0 && bankExec === 0 && bankInj === 0 && R.control.ok && bankApplied === R.bank.length,
    };
    log('\n================ 汇总 ================');
    /* 全部落成断言：既给 run_all 可判定的信号，也避免"打印了 0 执行"却被当成通过 */
    t('主用例 ' + R.main.length + ' 例：payload 无一被执行', 'XSS 主用例', mainExec === 0,
      'executed=' + mainExec + '/' + R.main.length + (mainExec ? ' 例：' + R.main.filter(x => x.executed).map(x => '#' + x.no).join(',') : ''));
    t('主用例 ' + R.main.length + ' 例：payload 无一被解析成元素', 'XSS 主用例', mainInj === 0,
      'injected=' + mainInj + '/' + R.main.length);
    t('补充用例 ' + R.extra.length + ' 组：无一执行', 'XSS 补充', extraExec === 0, 'executed=' + extraExec + '/' + R.extra.length);
    t('补充用例 ' + R.extra.length + ' 组：无一注入', 'XSS 补充', extraInj === 0, 'injected=' + extraInj + '/' + R.extra.length);
    t('题库篡改 ' + R.bank.length + ' 例：每一例都真的改到了题库（前置条件成立）', 'XSS 题库',
      bankApplied === R.bank.length, 'applied ok=' + bankApplied + '/' + R.bank.length +
      (bankApplied < R.bank.length ? '，未生效：' + R.bank.filter(x => x.applied !== 'ok').map(x => x.id + '=' + x.applied).join(',') : ''));
    t('题库篡改 ' + R.bank.length + ' 例：无一执行', 'XSS 题库', bankExec === 0, 'executed=' + bankExec + '/' + R.bank.length);
    t('题库篡改 ' + R.bank.length + ' 例：无一注入', 'XSS 题库', bankInj === 0, 'injected=' + bankInj + '/' + R.bank.length);
    t('主用例、补充用例全程无页面 JS 报错', 'XSS 主用例', pageErrs.length === 0,
      pageErrs.length ? JSON.stringify(pageErrs).slice(0, 300) : '0 个');
    log(`  结论：${R.summary.pass ? '通过（0 执行 / 0 注入，且 13 例题库篡改均已生效）' : '未通过，见上面明细'}`);

    fs.writeFileSync(path.join(DOCS, 'retest-xss-result.json'), JSON.stringify(R, null, 2), 'utf8');
    fs.writeFileSync(path.join(DOCS, 'retest-xss-log.txt'), LINES.join('\n'), 'utf8');
    await browser.close();
    log('\n已写出 docs/retest-xss-result.json 与 docs/retest-xss-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'retest-xss-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  }
})();
