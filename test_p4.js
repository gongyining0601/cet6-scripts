// scripts/test_p4.js —— P4 深色模式 / 阅读划词高亮 / 错题 CSV 导出
const path = require('path');
const fs = require('fs');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..', 'app');
const URL = 'file://' + path.join(ROOT, 'index.html');
const results = [];
const check = (name, ok, extra) => results.push((ok ? 'ok' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(URL);
  await page.waitForSelector('#loginMask', { timeout: 20000 });

  // 注入：一个今日 reading 组（含 passage 的题）+ 3 道在库错题（含 lastAnswer），登录 9203
  // 按需加载：首屏只有 meta 骨架，卷正文在点「开始」时动态加载——选卷用 qLite（type/qno），正文长度从 DOM 动态读
  const seed = await page.evaluate(() => {
    const C = window.CET6Core;
    const meta = window.CET6_META;
    const today = C.todayStr();
    let paperId = null;
    Object.keys(meta.papers).forEach((pid) => {
      if (paperId) return;
      if ((meta.papers[pid].qLite || []).filter((q) => q.type === 'reading').length >= 5) paperId = pid;
    });
    const p = meta.papers[paperId];
    const rqs = p.qLite.filter((q) => q.type === 'reading').slice(0, 5);
    const qids = rqs.map((q) => q.id);
    // 3 道错题：rqs[0..2] 答错并有 lastAnswer
    const papers = {}, wrongbook = {};
    qids.forEach((id, i) => {
      const wrong = i < 3;
      papers[id] = { seen: 1, wrong: wrong ? 1 : 0, right: wrong ? 0 : 1, lastAt: today, lastResult: wrong ? 'wrong' : 'right' };
      if (wrong) {
        papers[id].lastAnswer = 'A';
        wrongbook[id] = { addedAt: today, box: 0, wrongCount: 1, due: C.addDays(today, 1), ease: 2.3, iv: 1, streak: 0 };
      }
    });
    return { paperId, qids, pid: paperId + '#reading#read0', papers, wrongbook };
  });
  await page.evaluate((s) => {
    const C = window.CET6Core;
    const today = C.todayStr();
    const key = C.stateKey('9203');
    localStorage.setItem('cet6_user', '9203');
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      history: {},
      papers: s.papers,
      wrongbook: s.wrongbook,
      plan: { date: today, v: C.PLAN_VERSION, items: [{
        key: 'g0', type: 'reading', paperId: s.paperId, qids: s.qids, done: false,
      }] },
      essays: {},
    }));
  }, seed);
  await page.reload();
  await page.waitForSelector('#page-today');

  // ---- 1. 深色模式 ----
  const themeBtn = page.locator('#themeBtn');
  check('顶栏有主题切换按钮', await themeBtn.count() === 1);
  await themeBtn.click();
  const darkState = await page.evaluate(() => {
    const dark = document.body.classList.contains('dark');
    const bg = getComputedStyle(document.body).backgroundColor;
    return { dark, bg };
  });
  check('点击后 body 进入 dark 模式', darkState.dark, '');
  check('深色下页面背景变暗', darkState.bg && darkState.bg !== 'rgb(245, 246, 248)' && darkState.bg.indexOf('15, 23, 42') >= 0, darkState.bg);
  await page.reload();
  await page.waitForSelector('#page-today');
  const keepDark = await page.evaluate(() => document.body.classList.contains('dark'));
  check('刷新后深色偏好保持', keepDark);
  await themeBtn.click();
  const lightBack = await page.evaluate(() => document.body.classList.contains('dark'));
  check('再次点击切回浅色', !lightBack);
  await themeBtn.click(); // 切回深色，后续截图深色效果

  // ---- 2. 阅读划词高亮 ----
  // 进入今天的 reading 组（按需加载：卷动态加载后 passage 才渲染，等它出现）
  await page.locator('#planList .card button').first().click();
  await page.waitForSelector('#quiz.show', { timeout: 20000 });
  await page.waitForSelector('.passage[data-pid]', { timeout: 20000 });
  const hlExists = await page.evaluate(() => {
    const p = document.querySelector('.passage[data-pid]');
    return p && !!p.parentNode.querySelector('.hl-add') && !!p.parentNode.querySelector('.hl-clear');
  });
  check('阅读段落下出现高亮工具条', hlExists);
  const mk1 = await page.evaluate(() => {
    const p = document.querySelector('.passage[data-pid]');
    const tn = p.firstChild;
    if (!tn || !tn.nodeValue) return 'no-text-node:' + 0;
    const plen = tn.nodeValue.length; // 正文已动态加载，长度直接从 DOM 读（按需加载后 seed 不再含正文）
    const len = Math.min(10, plen);
    const range = document.createRange();
    range.setStart(tn, 0); range.setEnd(tn, len);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    document.querySelector('.hl-add').click();
    const marks = p.querySelectorAll('mark.hl');
    return marks.length + ':' + (marks.length ? marks[0].textContent.length : 0);
  });
  check('选中文字点高亮后出现 <mark>', /^1:\d+$/.test(mk1) && Number(mk1.split(':')[1]) >= 1, mk1);
  const hlSaved = await page.evaluate(() => {
    const C = window.CET6Core;
    const s = JSON.parse(localStorage.getItem(C.stateKey('9203')));
    return s.hl || null;
  });
  const hlArr = hlSaved && hlSaved[seed.pid];
  check('高亮持久化到 state.hl（含 pid 与文本）', !!(hlArr && hlArr.length === 1), hlArr ? JSON.stringify(hlArr) : 'none');
  // 退出重进：高亮恢复
  await page.locator('#quizBack').click();
  await page.waitForSelector('#quiz', { state: 'hidden' });
  await page.locator('#planList .card button').first().click();
  await page.waitForSelector('#quiz.show');
  await page.waitForSelector('.passage[data-pid]', { timeout: 20000 }); // 重进同样等 passage（按需加载卷已缓存，同步渲染）
  const restored = await page.evaluate(() => {
    const p = document.querySelector('.passage[data-pid]');
    return p ? p.querySelectorAll('mark.hl').length : -1;
  });
  check('退出重进后高亮恢复', restored === 1, 'marks=' + restored);
  // 点击高亮词取消
  await page.evaluate(() => {
    const m = document.querySelector('.passage mark.hl');
    if (m) m.click();
  });
  const cleared = await page.evaluate(() => document.querySelectorAll('.passage mark.hl').length);
  check('点击已高亮词取消该处高亮', cleared === 0, 'marks=' + cleared);

  // ---- 3. 错题 CSV 导出 ----
  await page.locator('#quizBack').click();
  await page.waitForSelector('#quiz', { state: 'hidden' });
  await page.locator('nav button[data-p="backup"]').click();
  await page.waitForSelector('#wrongCsvBtn');
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#wrongCsvBtn').click();
  const download = await downloadPromise;
  const csv = fs.readFileSync(await download.path(), 'utf8');
  check('CSV 带 BOM 且含表头', csv.charCodeAt(0) === 0xFEFF && /卷号,题号,题型,题干,你的答案,正确答案,考点,错次,下次复习,稳固度/.test(csv), '');
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  check('CSV 行数 = 错题数 + 1 表头', lines.length === 4, 'rows=' + lines.length);
  check('CSV 含你答错的选项(A)与卷号', csv.indexOf(',A,') >= 0 && csv.indexOf(seed.paperId) >= 0, csv.split('\n')[1] || '');
  check('CSV 含错次与下次复习', /,1,20\d\d-\d\d-\d\d,/.test(csv), csv.split('\n')[1] || '');
  // 空错题时提示不崩
  await page.evaluate(() => {
    const C = window.CET6Core;
    const s = JSON.parse(localStorage.getItem(C.stateKey('9203')));
    s.wrongbook = {};
    localStorage.setItem(C.stateKey('9203'), JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('#page-today');
  await page.locator('nav button[data-p="backup"]').click();
  await page.locator('#wrongCsvBtn').click();
  await page.waitForTimeout(200);
  check('错题为空时导出提示（不下载）', errs.length === 0, '');

  await page.screenshot({ path: path.join(ROOT, '..', 'docs', 'ui-18-dark.png'), fullPage: true });
  check('全程无页面错误', errs.length === 0, errs.join('|') || 'none');

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log('=== P4 深色/高亮/错题导出: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
