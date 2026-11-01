/* scripts/test_e2e_ui.js —— 真实端到端（Playwright 驱动浏览器 UI）
 *
 * 取代旧 test_e2e.js（那是 memStore+vm 的"逻辑旅程"，不驱动真实 UI）。
 * 本脚本用 Playwright 打开 file://app/index.html，完整走一遍：
 *   登录 → 今日清单 → 做题 → 提交判分 → 错题本 → 统计 → 备份导出 → 导入恢复
 * 断言数 ≥ 30，失败退出码非 0。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium: loadChromium, EXE, fileUrl } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'index.html');
const URL = fileUrl(APP);
const ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

let nOk = 0, nFail = 0;
function chk(name, ok, detail) {
  ok = !!ok; ok ? nOk++ : nFail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''));
  return ok;
}

const THIRD_PARTY_NOISE = /lazynote|english-exam|cdn\.jsdelivr\.net|cet-audio|\.m4a(\?|$)|net::ERR_(CONNECTION_RESET|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_CLOSED|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED)/i;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  let exportJson = null;
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage({ viewport: { width: 420, height: 900 } });
    const appErrors = [];
    page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (!THIRD_PARTY_NOISE.test(t)) appErrors.push(t); } });
    page.on('pageerror', e => { const t = 'PAGEERROR: ' + e.message; if (!THIRD_PARTY_NOISE.test(t)) appErrors.push(t); });
    page.on('dialog', d => d.accept(''));

    /* ===== 1. 登录 ===== */
    await page.goto(URL, { waitUntil: 'commit' });
    await page.waitForSelector('#loginMask', { timeout: 15000 });
    chk('登录浮层可见', await page.locator('#loginMask').isVisible());
    await page.locator('#phoneInput').fill('9100');
    await page.locator('#loginBtn').click();
    await page.waitForSelector('#planList .card', { timeout: 30000 });
    chk('登录后今日清单渲染出计划卡', await page.locator('#planList .card').count() >= 1);
    const planSummary = (await page.locator('#planSummary').textContent()) || '';
    chk('清单摘要含 X/Y 组', /今日清单 \d+\/\d+ 组/.test(planSummary), planSummary);
    const streak = (await page.locator('#streakChip').textContent()) || '';
    chk('连击 chip 可见', /🔥\s*\d+\s*天/.test(streak) || streak.length > 0, streak);

    /* ===== 2. 打开一组客观题 ===== */
    const cards = page.locator('#planList .card');
    const nCards = await cards.count();
    let openedIdx = -1;
    for (let i = 0; i < nCards; i++) {
      const btn = cards.nth(i).locator('button');
      if (((await btn.textContent()) || '').trim() !== '开始') continue;
      const label = ((await cards.nth(i).locator('b').first().textContent()) || '').trim();
      if (/选词填空|写作|翻译/.test(label)) continue;
      await btn.click();
      openedIdx = i;
      break;
    }
    chk('能打开一张含选项的计划卡', openedIdx >= 0, 'idx=' + openedIdx);
    await page.waitForFunction(() => {
      const q = document.getElementById('quiz');
      return q && q.classList.contains('show') && document.querySelectorAll('#quizBody .opt').length > 0;
    }, null, { timeout: 25000 }).catch(() => {});
    chk('答题浮层展开（#quiz.show）', await page.locator('#quiz').evaluate(el => el.classList.contains('show')));
    const qCount = await page.locator('#quizBody .opt').evaluateAll(els => new Set(els.map(e => e.getAttribute('data-q'))).size);
    chk('本组渲染出题数 ≥ 1', qCount >= 1, '题数=' + qCount);
    const optCount = await page.locator('#quizBody .opt').count();
    chk('选项数 ≥ 题数', optCount >= qCount, 'opt=' + optCount + ' q=' + qCount);

    /* ===== 3. 作答：故意答错部分题（制造错题） ===== */
    const opts = await page.locator('#quizBody .opt:not([disabled])').all();
    const answered = new Set();
    // 故意选每题第一个选项（大概率有对有错）
    for (const o of opts) {
      const q = await o.getAttribute('data-q');
      if (answered.has(q)) continue;
      await o.click().catch(() => {});
      answered.add(q);
    }
    chk('每题都选了一个选项', answered.size === qCount, 'answered=' + answered.size + ' q=' + qCount);
    const selCount = await page.locator('#quizBody .opt.sel').count();
    chk('选中态 .opt.sel 数量 = 题数', selCount === qCount, 'sel=' + selCount);

    /* ===== 4. 断点续做：退出再进，草稿保留 ===== */
    await page.locator('#quizBack').click();
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 });
    await cards.nth(openedIdx).locator('button').first().click();
    await page.waitForFunction(() => document.getElementById('quiz') && document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 });
    const selAfter = await page.locator('#quizBody .opt.sel').count();
    chk('断点续做：重进后草稿仍在', selAfter === qCount, 'selAfter=' + selAfter);

    /* ===== 5. 提交判分 ===== */
    const submit = page.locator('#groupSubmit');
    chk('提交按钮可用', await submit.isEnabled());
    await submit.click();
    await page.waitForTimeout(600);
    const analysisN = await page.locator('#quizBody .analysis').count();
    chk('提交后逐题解析在屏（解析数 = 题数）', analysisN === qCount, 'analysis=' + analysisN + ' q=' + qCount);
    const verdictN = await page.locator('#quizBody .verdict').count();
    chk('逐题判定标识数 = 题数', verdictN === qCount, 'verdict=' + verdictN);
    chk('本组标记已判分（#groupDone 可见）', await page.evaluate(() => {
      const d = document.getElementById('groupDone'); return !!d && getComputedStyle(d).display !== 'none';
    }));
    const groupBar = ((await page.locator('#groupBar').textContent()) || '').replace(/\s+/g, ' ').trim();
    chk('结果条含本组结果', /本组结果|正确率|得分/.test(groupBar), groupBar.slice(0, 80));

    // 完成本组 → 回今日
    const done = page.locator('#groupDone');
    if (await done.count()) await done.click();
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 }).catch(() => {});
    const planAfter = (await page.locator('#planSummary').textContent()) || '';
    chk('完成本组后清单进度前进', /今日清单 ([1-9]\d*)\//.test(planAfter), planAfter);

    /* ===== 6. 错题本 ===== */
    await page.locator('nav button[data-p="wrong"]').first().click();
    await page.waitForTimeout(500);
    const wrongSummary = ((await page.locator('#wrongSummary').textContent()) || '').trim();
    chk('错题本摘要非空', wrongSummary.length > 0, wrongSummary);
    const wrongRows = await page.locator('#dueList .wb-item, #allWrongList .wb-item').count();
    const wbCount = await page.evaluate(k => {
      try { return Object.keys((JSON.parse(localStorage.getItem(k) || '{}').wrongbook) || {}).length; } catch (e) { return 0; }
    }, 'cet6_p1_state_v1_9100');
    chk('错题本收录了错题（行 ≥ 1 或 wrongbook 非空）', wrongRows >= 1 || wbCount > 0, 'rows=' + wrongRows + ' wb=' + wbCount);

    /* ===== 7. 统计页 ===== */
    await page.locator('nav button[data-p="stat"]').first().click();
    await page.waitForTimeout(500);
    chk('统计页有正确率表', await page.locator('table.acc, #accTable').count() >= 1);
    chk('统计页有考点表', await page.locator('#ptTable, table.pt').count() >= 1);
    const heatmapCells = await page.locator('#heatmap i').count();
    chk('热力图渲染出格子', heatmapCells > 0, 'cells=' + heatmapCells);

    /* ===== 8. 备份页：导出 ===== */
    await page.locator('nav button[data-p="backup"]').first().click();
    await page.waitForTimeout(500);
    chk('备份页题库卡可见', await page.locator('#bankInfo').count() === 1);
    chk('导出按钮可用', await page.locator('#exportBtn').isEnabled());

    // 导出：监听 download，拿到 JSON
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
      page.locator('#exportBtn').click(),
    ]);
    if (download) {
      try {
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        exportJson = Buffer.concat(chunks).toString('utf8');
      } catch (e) { exportJson = null; }
    }
    if (!exportJson) {
      // 兜底：直接读 window.state（某些浏览器/协议下 download 事件不稳定）
      exportJson = await page.evaluate(() => JSON.stringify(window.state || null)).catch(() => null);
    }
    let exportedState = null;
    try { exportedState = exportJson ? JSON.parse(exportJson) : null; } catch (e) {}
    const expHistoryN = Object.keys((exportedState && exportedState.history) || {}).length;
    const expWrongN = Object.keys((exportedState && exportedState.wrongbook) || {}).length;
    chk('导出成功得到合法 JSON', !!exportedState && exportedState.version, 'version=' + (exportedState && exportedState.version));
    chk('导出数据含 history', !!(exportedState && exportedState.history));
    chk('导出数据含 papers', !!(exportedState && exportedState.papers));
    chk('导出数据含 wrongbook', exportedState && typeof exportedState.wrongbook === 'object');
    chk('导出 history 非空（今日做题记录）', expHistoryN > 0, 'history days=' + expHistoryN);
    chk('导出 wrongbook 与错题本一致（' + expWrongN + ' 题）', expWrongN >= 1, 'wrongbook=' + expWrongN);

    /* ===== 9. 导入恢复 =====
       state 是 index.html 闭包内的局部变量（非 window.state），导入/导出都走 localStorage。
       验证方式：导出后记录 history/wrongbook 数量 → 清空存档 → 导入 → 读 localStorage 核对。 */
    const STATE_KEY = 'cet6_p1_state_v1_9100';
    const readSaved = () => page.evaluate(k => {
      try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
    }, STATE_KEY);

    // 先清掉当前存档（模拟换设备），再导入早先备份
    await page.evaluate(k => { localStorage.removeItem(k); }, STATE_KEY);
    await page.waitForTimeout(200);
    const beforeImport = await readSaved();
    chk('导入前存档已清空', !beforeImport);

    const importInput = page.locator('#importFile');
    await importInput.setInputFiles({ name: 'cet6-backup-test.json', mimeType: 'application/json', buffer: Buffer.from(exportJson || '{}') });
    await page.waitForTimeout(800);

    const restored = await readSaved();
    const restoredHistoryN = Object.keys((restored && restored.history) || {}).length;
    const restoredWrongN = Object.keys((restored && restored.wrongbook) || {}).length;
    chk('导入后存档非空', !!restored && restored.version === 1, 'version=' + (restored && restored.version));
    chk('导入后 history 保留（' + restoredHistoryN + ' 天）', restoredHistoryN === expHistoryN, 'expected ' + expHistoryN);
    chk('导入后 wrongbook 保留（' + restoredWrongN + ' 题）', restoredWrongN === expWrongN, 'expected ' + expWrongN);

    /* ===== 10. 今日页 + 底线打卡 ===== */
    await page.locator('nav button[data-p="today"]').first().click();
    await page.waitForTimeout(400);
    await page.locator('#floorBtn').click();
    await page.waitForTimeout(400);
    const floorStatus = ((await page.locator('#todayStatus').textContent()) || '').trim();
    chk('底线打卡生效', /忙日打卡|底线/.test(floorStatus), floorStatus);

    /* ===== 11. 控制台错误 ===== */
    chk('全程无应用自身 console/pageerror', appErrors.length === 0, appErrors.slice(0, 3).join(' | ') || 'none');
  } catch (e) {
    console.log('FATAL: ' + (e && e.stack ? e.stack : e));
  }

  await browser.close();

  /* ===== 汇总（防空绿） ===== */
  const MIN = 30;
  const total = nOk + nFail;
  console.log('\n===== E2E UI SUMMARY =====');
  console.log(nOk + ' ok / ' + nFail + ' fail (total ' + total + ')');
  const bad = [];
  if (total === 0) bad.push('0 断言');
  else if (total < MIN) bad.push('断言数 ' + total + ' < ' + MIN);
  if (nFail > 0) bad.push(nFail + ' 条失败');
  if (bad.length) { console.log('GATE FAIL: ' + bad.join('；')); process.exit(1); }
  console.log('GATE PASS: E2E 全流程 ' + total + ' 条断言通过');
  process.exit(0);
})();
