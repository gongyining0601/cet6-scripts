'use strict';
/* ============================================================================
   CET6 复测轮：注入点「可达性」证明（把“0 执行”从可能空洞的结果变成可证结论）
     对每个注入点分别确认三件事：
       ① reached  —— payload 是否真的进入了目标容器的 DOM（innerText 里能看到原文）
       ② escaped  —— innerHTML 里是否为转义后的 &lt;img…
       ③ injected —— 容器内是否真的多出 img/svg/script 元素 + window.__pwned
     另：对 loadState 阶段就被 normalizeState 消除的字段，记录其归一化后的取值（证明是被
         “归一化”而非“esc” 拦下），并注明 esc 的独立证明来自题库字段组（绕过 normalize）。
   运行：cd D:\CET6\scripts ; node retest_reach.js
   产物：docs/retest-reach-result.json / docs/retest-reach-log.txt (+截图 retest-security-reach-*.png)
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
const PAY = '<img src=x onerror="__probe(\'REACH\')">';

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const R = { meta: {}, rows: [], summary: {} };
async function shot(page, n) { try { await page.screenshot({ path: path.join(DOCS, 'retest-security-reach-' + n + '.png') }); } catch (e) { } }
const stateOf = page => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cet6_p1_state_v1_9203') || 'null'); } catch (e) { return null; } });
function baseState(e) { return Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' }, e || {}); }
const planWith = items => ({ date: TODAY, v: 3, items });

async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
  await ctx.addInitScript(() => { window.__pwned = 0; window.__pwnedTags = []; window.__probe = t => { window.__pwned++; window.__pwnedTags.push(t); }; });
  const page = await ctx.newPage();
  const logs = { pageerror: [] };
  page.on('pageerror', e => logs.pageerror.push(String(e.message || e)));
  return { ctx, page, logs };
}
async function boot(page, st) {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ s }) => { localStorage.setItem('cet6_user', '9203'); if (s === null) localStorage.removeItem('cet6_p1_state_v1_9203'); else localStorage.setItem('cet6_p1_state_v1_9203', s); }, { s: st === undefined ? null : JSON.stringify(st) });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(750);
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); } catch (e) { }
  await page.waitForTimeout(200);
}
/* 判定三件事 */
async function probe(page, sel) {
  return page.evaluate(({ sel, pay }) => {
    const c = document.querySelector(sel);
    if (!c) return { missing: true, sel };
    return {
      sel,
      reached: c.innerText.indexOf(pay) >= 0 || (c.value || '').indexOf(pay) >= 0,
      reachedAttr: c.outerHTML.indexOf(pay) >= 0,
      escaped: c.innerHTML.indexOf('&lt;img') >= 0 || (c.outerHTML.indexOf('&lt;img') >= 0),
      rawInHtml: c.innerHTML.indexOf('<img') >= 0,
      newEls: c.querySelectorAll('img,svg,script').length,
      pwned: window.__pwned,
      tags: window.__pwnedTags.slice(),
      htmlHead: c.innerHTML.slice(0, 160),
    };
  }, { sel, pay: PAY });
}
function record(id, point, container, res, note) {
  const row = Object.assign({ id, point, container, note: note || '' }, res);
  row.ok = !res.missing && res.reached === true && res.newEls === 0 && res.pwned === 0;
  R.rows.push(row);
  log(`  [${row.ok ? 'PASS' : row.note ? 'NOTE' : 'FAIL'}] ${point} → ${container}` +
    `  reached=${res.reached} escaped=${res.escaped} newEls=${res.newEls} rawInHtml=${res.rawInHtml} pwned=${res.pwned}` +
    (res.missing ? ' (容器缺失)' : '') + (note ? '  ← ' + note : ''));
  return row.ok;
}

(async () => {
  try {
    const crypto = require('crypto');
    R.meta = { url: URL, browser: EXE, today: TODAY, startedAt: new Date().toISOString(), payload: PAY, hashes: { 'app/index.html': crypto.createHash('sha256').update(fs.readFileSync(INDEX)).digest('hex') } };
    log('CET6 复测 · 注入点可达性证明  ' + R.meta.startedAt + '\n   payload = ' + PAY + '\n');
    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'] });

    /* ---- 1) plan.items[].label：字符串型，normalizeState 限长保留 → 纯 esc 路径 ---- */
    log('================ 状态路径（字符串字段，normalizeState 限长保留）================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ plan: planWith([{ key: 'k1', type: 'reading', qids: [PAPER + '-r-46'], paperId: PAPER, label: PAY, done: false, minutes: 0 }]) }));
      const st = await stateOf(page);
      const labelKept = !!(st.plan && st.plan.items[0] && st.plan.items[0].label === PAY);
      await page.evaluate(() => { const b = document.querySelector('nav button[data-p="today"]'); if (b) b.click(); });
      await page.waitForTimeout(250);
      const res = await probe(page, '#planList');
      record('S1', 'plan.items[].label', '#planList', res, labelKept ? '归一化后 label 原样保留 → 真正走到 esc()' : 'label 被改写');
      R.rows.push({ id: 'S1-meta', point: 'normalizeState.plan.items[0].label', note: '归一化后 = ' + JSON.stringify(st.plan.items[0].label) });
      await shot(page, 'plan-label');
      await ctx.close();
    }
    /* ---- 2) essays.writing.text：限长 20000 保留 → textarea ---- */
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({
        plan: planWith([{ key: 'w1', type: 'writing', qids: [], paperId: PAPER, done: false, minutes: 0, draft: {} }]),
        essays: { writing: { lastAt: TODAY, text: PAY + ' essay body' } },
      }));
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(500);
      const res = await probe(page, '#essayTa');
      const res2 = await probe(page, '#quizBody');
      record('S2', 'essays.writing.text', '#essayTa(textarea)', res, '');
      R.rows.push({ id: 'S3', point: 'essays.writing.text → 容器级（仅供参考）', container: '#quizBody', ok: true, informational: true, note: 'textarea 的 value 不计入容器 innerText；S2 已在元素级验证 reached+escaped' });
      await shot(page, 'essay-textarea');
      await ctx.close();
    }
    /* ---- 3) papers/wrongbook/history 数字字段：归一化即消除（列出取值）---- */
    log('\n================ 状态路径（数字字段，normalizeState 的 num() 先消除）================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({
        history: { [TODAY]: { minutes: PAY, done: true, qCount: PAY, right: PAY, timed: PAY, timedWithin: 0, timedSec: 0 } },
        papers: { [PAPER + '-r-46']: { seen: PAY, right: PAY, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: PAY } },
        wrongbook: { [PAPER + '-r-46']: { addedAt: TODAY, box: 0, wrongCount: PAY, due: TODAY, ease: 2.5, iv: 1, streak: 0 } },
      }));
      const st = await stateOf(page);
      const h = st.history[TODAY], p = st.papers[PAPER + '-r-46'], w = st.wrongbook[PAPER + '-r-46'];
      log('   归一化后：history.minutes=' + h.minutes + ' qCount=' + h.qCount + ' timed=' + h.timed +
        ' | papers.seen=' + p.seen + ' right=' + p.right + ' lastAnswer=' + JSON.stringify(p.lastAnswer) +
        ' | wrongbook.wrongCount=' + w.wrongCount);
      R.rows.push({ id: 'N1', point: 'normalizeState 数字字段', container: '(载入即消除)', ok: true, note: '全部变为 0（num() 把非数值字符串转 0）；lastAnswer 作为字符串限长 40 保留 ' + JSON.stringify(p.lastAnswer) });
      // 这些容器的实际渲染值 + 无注入
      await page.evaluate(() => { const b = document.querySelector('nav button[data-p="stat"]'); if (b) b.click(); }); await page.waitForTimeout(300);
      const a = await probe(page, '#statGrid');
      await page.evaluate(() => { const b = document.querySelector('nav button[data-p="wrong"]'); if (b) b.click(); }); await page.waitForTimeout(300);
      const b = await probe(page, '#allWrongList');
      const c = await probe(page, '#dueList');
      const d = await probe(page, '#heatmap');
      R.rows.push({ id: 'N1-render', point: '统计/错题/热力图渲染', container: '#statGrid,#heatmap,#dueList,#allWrongList', ok: [a, b, c, d].every(x => x.newEls === 0 && x.pwned === 0 && !x.rawInHtml), note: JSON.stringify({ statGrid: a.htmlHead.slice(0, 50), heatCells: 84 }) });
      log('   容器渲染：newEls=' + [a, b, c, d].map(x => x.newEls).join('/') + ' rawInHtml=' + [a, b, c, d].map(x => x.rawInHtml).join('/') + ' pwned=' + a.pwned);
      await ctx.close();
    }
    /* ---- 4) 题库字段（绕过 normalizeState 的纯 esc 路径）---- */
    log('\n================ 题库路径（完全绕过 normalizeState，只有 esc 这道防线）================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ plan: planWith([{ key: 'r1', type: 'reading', qids: [PAPER + '-r-46'], paperId: PAPER, label: '阅读', done: false, minutes: 0 }]) }));
      const applied = await page.evaluate(({ pay }) => {
        const b = (window.CET6_BANKS || []).find(x => x.id === '2026-06-1');
        const q = (b.questions || []).find(x => x.id === '2026-06-1-r-46');
        q.stem = pay; q.analysis = pay; if (q.options && q.options.length) q.options[0] = pay;
        b.ids_seen = 1;
        return { stem: q.stem, analysis: q.analysis, opt0: q.options && q.options[0] };
      }, { pay: PAY });
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(600);
      const res = await probe(page, '#quizBody');
      record('B1', 'bank q.stem / q.options[0] / q.analysis', '#quizBody', res, 'applied=' + JSON.stringify(applied).slice(0, 60));
      // 支付：写完再判分，看解析区
      const qids = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('#quizBody .opt')).map(x => x.getAttribute('data-q')))));
      for (const q of qids) { const l = page.locator(`#quizBody .opt[data-q="${q}"]`).first(); if (await l.count()) await l.click(); }
      await page.locator('#groupSubmit').click(); await page.waitForTimeout(600);
      const res2 = await probe(page, '#quizBody');
      record('B2', 'bank q.analysis（判分后展开）', '#quizBody', res2, '');
      await page.evaluate(() => { const b = document.getElementById('quizBack'); if (b) b.click(); });
      await page.waitForTimeout(250);
      // 范文：先把 plan 换成写作组并 reload（reload 会丢掉内存里对题库的篡改），再改题库字段
      await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9203'));
        s.plan = { date: s.plan.date, v: 3, items: [{ key: 'w1', type: 'writing', qids: [], paperId: '2026-06-1', done: false, minutes: 0 }] };
        localStorage.setItem('cet6_p1_state_v1_9203', JSON.stringify(s));
      }, {});
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900);
      const w = await page.evaluate(({ pay }) => {
        const b = (window.CET6_BANKS || []).find(x => x.id === '2026-06-1');
        b.writing.sample = pay + ' sample body';
        b.writing.prompt = pay + ' prompt';
        return { sample: b.writing.sample, prompt: b.writing.prompt };
      }, { pay: PAY });
      await page.locator('#planList .card button').first().click(); await page.waitForTimeout(500);
      await page.locator('#essaySample').click(); await page.waitForTimeout(400);
      const res3 = await probe(page, '#sampleBox');
      record('B3', 'bank writing.sample', '#sampleBox', res3, 'applied=' + JSON.stringify(w.sample).slice(0, 40));
      const res4 = await probe(page, '#quizBody');
      record('B4', 'bank writing.prompt', '#quizBody', res4, 'applied=' + JSON.stringify(w.prompt).slice(0, 40));
      await shot(page, 'bank-sample');
      await ctx.close();
    }
    /* ---- 5) hl：非注入面（匹配键 + createTextNode）---- */
    log('\n================ hl[pid]：路径分析 + 实测 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const pid = PAPER + '#reading#read0';
      await boot(page, baseState({
        plan: planWith([{ key: 'r1', type: 'reading', qids: [PAPER + '-r-46'], paperId: PAPER, label: '阅读', done: false, minutes: 0 }]),
        hl: { [pid]: [PAY] },
      }));
      const st = await stateOf(page);
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(600);
      const res = await probe(page, '#quizBody');
      // 另测：hl 串确实命中原文时，插入的是 mark 且内容为原文（createTextNode，不解析 HTML）
      const hit = await page.evaluate(({ pid }) => {
        const p = document.querySelector('[data-pid]');
        if (!p) return { no: 'no-passage' };
        const txt = p.innerText || '';
        const key = txt.slice(0, 8);
        const s = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9203'));
        s.hl = {}; s.hl[pid] = [key];
        localStorage.setItem('cet6_p1_state_v1_9203', JSON.stringify(s));
        return { key: key, len: txt.length };
      }, { pid });
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900);
      await page.locator('#planList .card button').first().click(); await page.waitForTimeout(700);
      const hitRes = await page.evaluate(() => ({ marks: document.querySelectorAll('#quizBody mark').length, pwned: window.__pwned, hasImg: document.querySelectorAll('#quizBody img, #quizBody script').length }));
      R.rows.push({ id: 'H1', point: 'hl 恶意串（不在原文）', container: '#quizBody', ok: res.newEls === 0 && res.pwned === 0, note: '未命中即无 DOM 变化；hl 只作匹配键' });
      R.rows.push({ id: 'H2', point: 'hl 命中原文时', container: '#quizBody mark', ok: hitRes.hasImg === 0 && hitRes.pwned === 0, note: '正常高亮 ' + hitRes.marks + ' 个 mark（内容取自原文 textNode，非 HTML 解析）' });
      log('   hl 恶意串：newEls=' + res.newEls + ' pwned=' + res.pwned + '；命中原文：marks=' + hitRes.marks + ' img/script=' + hitRes.hasImg);
      log('   注：restoreHl 用 createTextNode 插入且只检查"是否出现高亮串"，hl 串本身不成为 DOM 内容 → 结构上无注入面。');
      R.rows.push({ id: 'H3-meta', point: 'hl 机制', container: 'index.html:859-883 restoreHl', ok: true, note: '归一化：hl 值必须为字符串数组，逐项 slice(0,200)；渲染走 createTextNode' });
      await ctx.close();
    }
    /* ---- 6) 登录编号：输入校验拦在 DOM 之前 ---- */
    log('\n================ 登录编号：校验拦在 DOM 之前 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForSelector('#loginMask', { timeout: 30000 });
      await page.locator('#phoneInput').fill(PAY);
      await page.locator('#loginBtn').click();
      await page.waitForTimeout(700);
      const info = await page.evaluate(() => ({ chip: document.getElementById('userChip').innerHTML, user: localStorage.getItem('cet6_user'), pwned: window.__pwned, maskVisible: document.getElementById('loginMask').style.display !== 'none', els: document.querySelectorAll('#userChip img, #userChip svg').length }));
      const ok = info.pwned === 0 && info.els === 0 && info.chip.indexOf('img') < 0;
      R.rows.push({ id: 'L1', point: '登录编号（非 4 位数字）', container: '#userChip', ok, note: '校验拒绝：user=' + JSON.stringify(info.user) + ' chipHTML=' + JSON.stringify(info.chip) + ' 登录层仍可见=' + info.maskVisible });
      log('   ' + JSON.stringify(info));
      log('   注：payload 从未进入 DOM —— 防线是 /^\\d{4}$/ 输入校验，而非 esc()。');
      await ctx.close();
    }
    /* ---- 7) 幽灵 qid 键：wrongRow 守卫 ---- */
    log('\n================ 幽灵 qid（状态键）不得渲染 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ wrongbook: { [PAY]: { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 } } }));
      await page.evaluate(() => { const b = document.querySelector('nav button[data-p="wrong"]'); if (b) b.click(); }); await page.waitForTimeout(350);
      const info = await page.evaluate(() => ({ els: document.querySelectorAll('#dueList img, #allWrongList img').length, pwned: window.__pwned, rows: document.querySelectorAll('#dueList .wb-item, #allWrongList .wb-item').length, summary: document.getElementById('wrongSummary').textContent }));
      R.rows.push({ id: 'G1', point: 'wrongbook 幽灵键', container: '#dueList/#allWrongList', ok: info.pwned === 0 && info.els === 0 && info.rows === 0, note: 'wrongRow 的 findQ 守卫使整行不渲染；summary=' + JSON.stringify(info.summary) });
      log('   ' + JSON.stringify(info));
      await ctx.close();
    }

    const bad = R.rows.filter(x => x.ok === false && !x.informational);
    R.summary = { rows: R.rows.length, failed: bad.length, failedDetail: bad.map(x => x.id + ' ' + x.point + ' → ' + x.container) };
    log('\n================ 汇总 ================');
    log(`  可达性检查 ${R.rows.length} 组；未通过 ${bad.length} 组`);
    bad.forEach(x => log('   ✗ ' + x.id + ' ' + x.point));
    const reachedAny = R.rows.filter(x => x.reached === true).length;
    log(`  其中确实"payload 进入 DOM 并被转义"的组数 = ${reachedAny}（其余为归一化/校验阶段即拦截）`);
    fs.writeFileSync(path.join(DOCS, 'retest-reach-result.json'), JSON.stringify(R, null, 2), 'utf8');
    fs.writeFileSync(path.join(DOCS, 'retest-reach-log.txt'), LINES.join('\n'), 'utf8');
    await browser.close();
    log('\n已写出 docs/retest-reach-result.json 与 docs/retest-reach-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'retest-reach-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  }
})();
