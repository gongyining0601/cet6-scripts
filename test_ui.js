/* scripts/test_ui.js —— UI 冒烟实测（带断言）
 *
 * 由来：本脚本此前只 console.log 不声明 pass/fail，也没有退出码，run_all 里恒判 NO-ASSERT
 * （"跑了但没校验"）。这里保留原有截图产物，把每一处观测升级成硬断言，并补上退出码。
 *
 * 同时修掉两处按需加载（2026-10 架构）下的腐化：
 *   1) 硬按 `.opt` 作答 —— 计划首卡可能是选词填空（只有 .cloze-slot/.wb-chip），旧写法必卡死；
 *   2) 读 window.CET6_BANKS 校验题库卡 —— 首屏 BANKS 恒为空数组，断言恒假。
 *      题库卡实际由常驻的 meta 骨架（CET6_META）渲染，故改为按 meta.order 校验。
 *
 * 浏览器依赖：统一由 _env.js 探测（环境变量 CET6_BROWSER / PW_PATH，其次自动找 Edge / Chrome）
 * 用法：node test_ui.js
 * 产物：docs/ui-*.png、docs/ui-result.json
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const APP = path.join(ROOT, 'app', 'index.html');
const URL = 'file:///' + APP.replace(/\\/g, '/');
const ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

const R = { ts: new Date().toISOString(), checks: [], fatal: null };
let nOk = 0, nFail = 0;
function chk(name, ok, detail) {
  const c = { name, ok: !!ok, detail: detail === undefined || detail === null ? '' : String(detail) };
  R.checks.push(c); ok ? nOk++ : nFail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (c.detail ? ' | ' + c.detail : ''));
  return c;
}

/* 与 round3 同口径的题型判别：这几个题型没有 .opt */
const NON_OPT_LABEL = /选词填空|写作|翻译/;

const waitQuizOpen = (page) => page.waitForFunction(() => {
  const q = document.getElementById('quiz');
  if (!q || !q.classList.contains('show')) return false;
  const b = document.getElementById('quizBody');
  return !!b && (b.querySelectorAll('.opt').length > 0 || b.querySelectorAll('.cloze-slot').length > 0 ||
    document.getElementById('essayTa') || b.querySelector('iframe') || b.querySelector('.listen-player'));
}, null, { timeout: 25000 });

/* 打开"第一张有 .opt 的计划卡"（跳过选词填空/写作/翻译），返回卡序号与标签 */
async function openOptCard(page) {
  const cards = page.locator('#planList .card');
  const n = await cards.count();
  let fallback = null;
  for (let i = 0; i < n; i++) {
    const btn = cards.nth(i).locator('button');
    if (((await btn.textContent()) || '').trim() !== '开始') continue;
    const label = ((await cards.nth(i).locator('b').first().textContent()) || '').trim();
    if (!NON_OPT_LABEL.test(label)) { await btn.click(); await waitQuizOpen(page); return { i, label }; }
    if (!fallback) fallback = { i, label, btn };
  }
  if (fallback) { await fallback.btn.click(); await waitQuizOpen(page); return { i: fallback.i, label: fallback.label }; }
  return null;
}
async function openCardAt(page, i) {
  const cards = page.locator('#planList .card');
  await cards.nth(i).locator('button').click();
  await waitQuizOpen(page);
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    /* 第三方资源噪声不算"应用自身的 console error"：       · 懒笔记听力页/站点（lazynote / english-exam）
       · 烘焙音频 CDN 上的 .m4a（cdn.jsdelivr.net）——CDN 不可达时报
         "Failed to load resource: net::ERR_CONNECTION_RESET"，与页面 JS 无关。
       本机网络对这两个域是时通时断的，不过滤会造成随机假红（实测同一条用例
       一次 23/0、一次 22/1，失败明细全是这条 ERR_CONNECTION_RESET）。 */
    const THIRD_PARTY_NOISE = /lazynote|english-exam|cdn\.jsdelivr\.net|cet-audio|\.m4a(\?|$)|net::ERR_(CONNECTION_RESET|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_CLOSED|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED)/i;
    const appErrors = [];
    page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (THIRD_PARTY_NOISE.test(t)) return; appErrors.push(t); } });
    page.on('pageerror', e => { const t = 'PAGEERROR: ' + e.message; if (THIRD_PARTY_NOISE.test(t)) return; appErrors.push(t); });
    page.on('dialog', d => d.accept('1001'));

    await page.goto(URL, { waitUntil: 'commit' });
    await page.waitForTimeout(600);
    // 手机号登录（本地多账号）
    await page.evaluate(() => localStorage.setItem('cet6_user', '1001'));
    await page.reload({ waitUntil: 'commit' });
    await page.waitForTimeout(800);

    /* ---------- 1. 今日页首屏 ---------- */
    const planSummary = (await page.locator('#planSummary').textContent()) || '';
    const streakChip = (await page.locator('#streakChip').textContent()) || '';
    console.log('plan:', planSummary);
    console.log('streak chip:', streakChip);
    chk('今日页渲染出清单摘要（X/Y 组）', /今日清单 \d+\/\d+ 组/.test(planSummary), planSummary);
    chk('连击天数可见（🔥 N 天）', /🔥\s*\d+\s*天/.test(streakChip), streakChip);
    chk('计划卡 ≥ 1 张', await page.locator('#planList .card').count() >= 1);
    await page.screenshot({ path: path.join(DOCS, 'ui-1-today.png'), fullPage: true });

    /* ---------- 2. 进入第一组（整组同屏） ---------- */
    const opened = await openOptCard(page);
    chk('能打开一组题（优先选题库已下载且含 .opt 的组）', !!opened, JSON.stringify(opened));
    const qCount = await page.locator('.opt').evaluateAll(els => new Set(els.map(e => e.getAttribute('data-q'))).size);
    console.log('group questions on one screen:', qCount);
    chk('整组同屏：本组题目数 ≥ 1', qCount >= 1, '题数=' + qCount + ' 组=' + (opened && opened.label));
    chk('答题浮层已展开且背景被 inert（P1-b）', await page.evaluate(() => {
      const q = document.getElementById('quiz'), app = document.getElementById('app');
      return q.classList.contains('show') && (('inert' in app) ? app.inert === true : app.getAttribute('aria-hidden') === 'true');
    }));
    await page.screenshot({ path: path.join(DOCS, 'ui-2-group.png'), fullPage: true });

    /* ---------- 3. 断点续做：答 1 题退出，重进草稿还在 ---------- */
    await page.locator('.opt').first().click();
    await page.waitForTimeout(150);
    const selBeforeExit = await page.locator('.opt.sel').count();
    await page.locator('#quizBack').click();
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 });
    await openCardAt(page, opened.i);
    const draftKept = await page.locator('.opt.sel').count();
    console.log('draft kept after re-enter:', draftKept);
    chk('断点续做：退出前已选 1 项', selBeforeExit === 1, 'sel=' + selBeforeExit);
    chk('断点续做：重进后草稿仍在（.opt.sel 仍为 1）', draftKept === 1, 're-enter sel=' + draftKept);

    /* ---------- 4. 答完全部题 → 组底一次提交 → 判分 ---------- */
    const opts = await page.locator('.opt:not([disabled])').all();
    const answeredQ = new Set();
    for (const o of opts) {
      const q = await o.getAttribute('data-q');
      if (answeredQ.has(q)) continue;
      await o.click(); answeredQ.add(q); await page.waitForTimeout(50);
    }
    const submit = page.locator('#groupSubmit');
    const enabled = await submit.isEnabled();
    console.log('group submit enabled after all answered:', enabled);
    chk('答完本组后提交按钮可用', enabled, '已答 ' + answeredQ.size + ' 题');
    await submit.click();
    await page.waitForTimeout(500);
    const analysisCount = await page.locator('.analysis').count();
    console.log('analysis shown per question:', analysisCount);
    chk('提交后逐题解析在屏（解析数 === 题目数）', analysisCount === qCount, 'analysis=' + analysisCount + ' 题数=' + qCount);
    chk('提交后本组标记为已判分（#groupDone 可见）', await page.evaluate(() => {
      const d = document.getElementById('groupDone'); return !!d && getComputedStyle(d).display !== 'none';
    }));
    await page.screenshot({ path: path.join(DOCS, 'ui-3-judged.png'), fullPage: true });

    const done = page.locator('#groupDone');
    if (await done.count()) { await done.click(); await page.waitForTimeout(400); }
    const quizShown = await page.locator('#quiz').evaluate(el => el.classList.contains('show'));
    console.log('quiz closed after group:', !quizShown);
    chk('完成本组后答题浮层关闭', !quizShown);
    const planAfter = (await page.locator('#planSummary').textContent()) || '';
    console.log('plan after group:', planAfter);
    chk('完成后清单进度前进（已完成组数 ≥ 1）', /今日清单 ([1-9]\d*)\//.test(planAfter), planAfter);
    await page.screenshot({ path: path.join(DOCS, 'ui-4-after-group.png'), fullPage: true });

    /* ---------- 5. 底线（忙日）打卡 ---------- */
    await page.locator('#floorBtn').click();
    await page.waitForTimeout(400);
    const floorStatus = ((await page.locator('#todayStatus').textContent()) || '').trim();
    console.log('floor status:', floorStatus);
    chk('底线模式写下忙日打卡状态', /忙日打卡/.test(floorStatus), floorStatus);
    await page.screenshot({ path: path.join(DOCS, 'ui-8-floor.png'), fullPage: true });

    /* ---------- 6. 加练一组 ---------- */
    await page.locator('#extraBtns button:has-text("听力")').click();
    await page.waitForTimeout(400);
    const afterExtra = (await page.locator('#planSummary').textContent()) || '';
    const extraBadge = await page.locator('#planList .badge.extra').count();
    console.log('after extra:', afterExtra, '|', await page.locator('#todayMinutes').textContent());
    chk('加练一组后清单出现"加练"标记', extraBadge >= 1, 'extraBadge=' + extraBadge + ' 摘要=' + afterExtra);

    /* ---------- 7. 错题本 / 统计 / 备份 ---------- */
    await page.locator('nav button[data-p="wrong"]').click(); await page.waitForTimeout(400);
    const wrongSummary = ((await page.locator('#wrongSummary').textContent()) || '').trim();
    console.log('wrong:', wrongSummary);
    chk('错题本摘要非空', wrongSummary.length > 0, wrongSummary);
    await page.screenshot({ path: path.join(DOCS, 'ui-5-wrong.png'), fullPage: true });

    await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(400);
    chk('统计页渲染出正确率表', await page.locator('table.acc').count() >= 1);
    await page.screenshot({ path: path.join(DOCS, 'ui-6-stat.png'), fullPage: true });

    await page.locator('nav button[data-p="backup"]').click(); await page.waitForTimeout(400);
    const bank = await page.evaluate(() => ({
      text: document.getElementById('bankInfo').textContent || '',
      order: (window.CET6_META || {}).order || [],
      banksLoaded: (window.CET6_BANKS || []).length,
    }));
    console.log('bank info visible:', bank.order.length, '套 | 已下载卷', bank.banksLoaded);
    // 按需加载后首屏 CET6_BANKS 恒为空，题库卡由常驻 meta 骨架渲染 —— 断言改为按 meta.order 校验
    chk('题库卡列出全部真题卷（来自 meta 骨架，不依赖卷是否已下载）',
      bank.order.length > 0 && bank.order.every((id) => bank.text.indexOf(id) >= 0),
      'meta 卷数=' + bank.order.length + ' 首屏已下载卷=' + bank.banksLoaded);
    chk('题库卡标注"按需加载"与总套数',
      /按需加载/.test(bank.text) && bank.text.indexOf('共 ' + bank.order.length + ' 套真题') >= 0,
      '共 ' + bank.order.length + ' 套真题');
    chk('备份页导出按钮可用', await page.locator('#exportBtn').isEnabled());
    await page.screenshot({ path: path.join(DOCS, 'ui-7-backup.png'), fullPage: true });

    /* ---------- 8. 重启浏览器验证持久化 ---------- */
    await browser.close();
    const b2 = await chromium.launch({ executablePath: EXE, args: ARGS });
    const p2 = await b2.newPage({ viewport: { width: 420, height: 900 } });
    const errs2 = [];
    p2.on('pageerror', e => { const t = 'PAGEERROR: ' + e.message; if (!THIRD_PARTY_NOISE.test(t)) errs2.push(t); });
    await p2.goto(URL, { waitUntil: 'commit' });
    await p2.waitForTimeout(500);
    await p2.evaluate(() => localStorage.setItem('cet6_user', '1001')); // 新实例无登录态，先登录
    await p2.reload({ waitUntil: 'commit' });
    await p2.waitForTimeout(900);
    // 注：playwright 新实例=全新浏览器 profile（localStorage 为空），此处验证的是「新设备登录后冷启动正常」；
    // 同浏览器内的断点续做/草稿保留已在上方 draft kept 验证过
    const cold = (await p2.locator('#planSummary').textContent()) || '';
    console.log('cold start on fresh profile after login:', cold);
    chk('全新 profile 登录后冷启动正常（清单照常生成）', /今日清单 \d+\/\d+ 组/.test(cold), cold);
    chk('冷启动无页面错误', errs2.length === 0, errs2.join(' | ') || 'none');
    await b2.close();

    /* ---------- 9. 控制台错误（已剔除第三方/CDN 噪声） ---------- */
    console.log('console errors（应用自身）:', appErrors.length ? appErrors.join(' | ') : 'none');
    chk('全程无 console error / pageerror', appErrors.length === 0, appErrors.slice(0, 3).join(' | ') || 'none');
  } catch (e) {
    R.fatal = String(e && e.stack ? e.stack : e);
    console.log('FATAL: ' + R.fatal);
  }

  /* ---------- 汇总 + 退出码（防空绿） ----------
     此前本脚本无退出码也无断言，run_all 里恒为 NO-ASSERT。以下三种一律判失败：
       fatal / 0 断言 / 存在 FAIL。 */
  R.ok = nOk; R.fail = nFail;
  fs.writeFileSync(path.join(DOCS, 'ui-result.json'), JSON.stringify(R, null, 1), 'utf8');
  console.log('\n===== UI SMOKE SUMMARY =====');
  console.log(nOk + ' ok / ' + nFail + ' fail');
  console.log('JSON -> docs/ui-result.json');

  const MIN_ASSERTIONS = 20;
  const bad = [];
  if (R.fatal) bad.push('fatal: ' + R.fatal.split('\n')[0]);
  if (nOk + nFail === 0) bad.push('0 断言：脚本未做任何校验');
  else if (nOk + nFail < MIN_ASSERTIONS) bad.push('断言总数 ' + (nOk + nFail) + ' < 下限 ' + MIN_ASSERTIONS);
  if (nFail > 0) bad.push(nFail + ' 条断言失败');
  if (bad.length) { console.log('GATE FAIL: ' + bad.join('；')); process.exit(1); }
  console.log('=== UI smoke done ===');
})();
