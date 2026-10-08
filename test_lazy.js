// scripts/test_lazy.js —— 按需加载（架构级）专项验证：
//   1) 首屏只有 meta 骨架（CET6_BANKS 空、CET6_META 完整 76 卷）
//   2) 点「开始」→ 动态加载当日卷 → 题目渲染
//   3) 统计页（估分/考点/专项练）不依赖卷是否加载（快照 + meta 兜底）
//   4) 错题本跨卷按需加载 → CSV 导出
//   5) 已加载卷不重复请求（缓存命中）
const path = require('path');
const { chromium: loadChromium, EXE, bankDigest } = require('./_env');
const { chromium } = loadChromium();
// 题库事实来源：两仓题量不同（本仓 3315 / 四级仓 3325），不得写死数字
const DIGEST = bankDigest();
const ROOT = path.join(__dirname, '..', 'app');
const URL = 'file://' + path.join(ROOT, 'index.html');
const results = [];
const check = (name, ok, extra) => results.push((ok ? 'ok' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('#loginMask', { timeout: 20000 });

  // ---- 1. 首屏骨架 ----
  const boot = await page.evaluate(() => ({
    banks: (window.CET6_BANKS || []).length,
    metaPapers: window.CET6_META ? Object.keys(window.CET6_META.papers).length : 0,
    metaOrder: window.CET6_META ? window.CET6_META.order.length : 0,
    metaQlite: (() => { let n = 0; if (window.CET6_META) Object.keys(window.CET6_META.papers).forEach((p) => n += (window.CET6_META.papers[p].qLite || []).length); return n; })(),
  }));
  check('首屏不加载任何卷正文（BANKS=0）', boot.banks === 0, 'banks=' + boot.banks);
  check('meta 骨架含 ' + DIGEST.papers.length + ' 卷 / ' + DIGEST.questions + ' 题（与题库实测一致）',
    boot.metaPapers === DIGEST.papers.length && boot.metaOrder === DIGEST.papers.length && boot.metaQlite === DIGEST.questions,
    'papers=' + boot.metaPapers + ' order=' + boot.metaOrder + ' qLite=' + boot.metaQlite + ' 期望=' + DIGEST.papers.length + '/' + DIGEST.questions);

  // ---- 2. 登录 → 清单（用 meta 生成）→ 点开始 → 动态加载当日卷 ----
  await page.locator('#phoneInput').fill('9301');
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  const pre = await page.evaluate(() => ({ banks: (window.CET6_BANKS || []).length, prog: document.querySelector('#todayMeta') ? document.querySelector('#todayMeta').textContent : '' }));
  check('清单生成后仍不加载卷（纯 meta 驱动）', pre.banks === 0, 'banks=' + pre.banks);
  const cardTxt = (await page.locator('#planList .card').first().textContent()) || '';
  check('今日清单含题型/卷号信息', /听力|选词|匹配|阅读/.test(cardTxt) && /20\d\d-\d\d-\d/.test(cardTxt), cardTxt.replace(/\s+/g, ' ').slice(0, 40));

  await page.locator('#planList .card button').first().click();
  await page.waitForSelector('#quiz.show', { timeout: 20000 });
  await page.waitForSelector('#quizBody .opt, #quizBody .optBtn, #quizBody .passage, #quizBody .cloze-slot', { timeout: 20000 });
  const after = await page.evaluate(() => ({
    banks: (window.CET6_BANKS || []).length,
    qids: (() => { const ids = []; document.querySelectorAll('#quizBody .opt, #quizBody .optBtn, #quizBody .cloze-slot').forEach((o) => { const q = o.getAttribute('data-q'); if (q && ids.indexOf(q) < 0) ids.push(q); }); return ids.length; })(),
    bodyLen: document.querySelector('#quizBody').innerHTML.length,
  }));
  check('点开始后动态加载当日卷（BANKS>0）且题目渲染', after.banks >= 1 && after.qids >= 1 && after.bodyLen > 300, 'banks=' + after.banks + ' 题=' + after.qids + ' 内容=' + after.bodyLen);

  // ---- 3. 已加载卷不重复请求 ----
  const scriptsBefore = await page.evaluate(() => document.querySelectorAll('script[src*="bank/cet6-"]').length);
  await page.locator('#quizBack').click();
  await page.waitForSelector('#quiz', { state: 'hidden' });
  await page.locator('#planList .card button').first().click();
  await page.waitForSelector('#quizBody .opt, #quizBody .optBtn, #quizBody .passage, #quizBody .cloze-slot', { timeout: 20000 });
  const scriptsAfter = await page.evaluate(() => document.querySelectorAll('script[src*="bank/cet6-"]').length);
  check('重进同组不重复加载卷脚本（缓存命中）', scriptsAfter === scriptsBefore, scriptsBefore + ' -> ' + scriptsAfter);
  await page.locator('#quizBack').click();
  await page.waitForSelector('#quiz', { state: 'hidden' });

  // ---- 4. 统计页不依赖卷加载（新账号只有 meta，估分/考点可算）----
  // 注入做题记录（带 points 快照，模拟已完成判分的跨卷记录），清空已加载卷
  await page.evaluate(() => {
    const C = window.CET6Core;
    const today = C.todayStr();
    const key = C.stateKey('9301');
    const meta = window.CET6_META;
    const all = [];
    Object.keys(meta.papers).forEach((pid) => { (meta.papers[pid].qLite || []).forEach((q) => all.push(q)); });
    const reading = all.filter((q) => q.type === 'reading' && q.points && q.points.length).slice(0, 4);
    const listening = all.filter((q) => q.type === 'listening' && q.points && q.points.length).slice(0, 3);
    const papers = {};
    reading.forEach((r, i) => { papers[r.id] = { seen: 1, right: i < 1 ? 1 : 0, wrong: i < 1 ? 0 : 1, lastAt: today, lastResult: i < 1 ? 'right' : 'wrong', points: r.points }; });
    listening.forEach((r) => { papers[r.id] = { seen: 1, right: 1, wrong: 0, lastAt: today, lastResult: 'right', points: r.points }; });
    localStorage.setItem(key, JSON.stringify({ version: 1, history: {}, papers, wrongbook: {}, plan: null, essays: {} }));
  });
  await page.reload();
  await page.waitForSelector('#page-today');
  await page.locator('nav button[data-p="stat"]').click();
  await page.waitForSelector('#statGrid');
  await page.waitForTimeout(300);
  const stat = await page.evaluate(() => ({
    est: (document.querySelector('#estCard') || {}).textContent || '',
    ptRows: document.querySelectorAll('#ptTable tbody tr').length,
    ptBtn: (document.querySelector('#pointTrainBtn') || {}).textContent || '',
  }));
  check('统计页估分卡可用（不依赖卷加载）', /估算分/.test(stat.est) && /\/ 710/.test(stat.est), stat.est.replace(/\s+/g, ' ').slice(0, 50));
  check('统计页考点表按 points 快照聚合（未加载任何卷）', stat.ptRows >= 1, 'rows=' + stat.ptRows);
  check('薄弱考点按钮由 meta 兜底算出', /专项练/.test(stat.ptBtn), stat.ptBtn.replace(/\s+/g, ' ').slice(0, 40));

  // ---- 5. 错题本：跨卷按需加载 ----
  await page.evaluate(() => {
    const C = window.CET6Core;
    const today = C.todayStr();
    const key = C.stateKey('9301');
    const s = JSON.parse(localStorage.getItem(key));
    // 错题分布在两卷（reading 卷 + listening 卷），均未加载
    const meta = window.CET6_META;
    const all = [];
    Object.keys(meta.papers).forEach((pid) => { (meta.papers[pid].qLite || []).forEach((q) => all.push(q)); });
    const r1 = all.filter((q) => q.type === 'reading')[0], l1 = all.filter((q) => q.type === 'listening')[0];
    s.wrongbook = {};
    [r1, l1].forEach((q) => { s.wrongbook[q.id] = { addedAt: today, box: 0, wrongCount: 1, due: today, ease: 2.3, iv: 1, streak: 0 }; }); // 今日到期 → 进到期区
    s.papers[r1.id].wrong = 1; s.papers[r1.id].right = 0; s.papers[r1.id].lastResult = 'wrong';
    s.papers[l1.id].wrong = 1; s.papers[l1.id].right = 0; s.papers[l1.id].lastResult = 'wrong';
    localStorage.setItem(key, JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('#page-today');
  await page.locator('nav button[data-p="wrong"]').click();
  await page.waitForSelector('#page-wrong .wb-item', { timeout: 20000 });
  const wrongTxt = (await page.locator('#page-wrong').textContent()) || '';
  check('错题本跨卷按需加载后显示题干与卷号', /题在库/.test(wrongTxt) && /共 2 题/.test(wrongTxt.replace(/\s+/g, ' ')) && /20\d\d-\d\d-\d/.test(wrongTxt), wrongTxt.replace(/\s+/g, ' ').slice(0, 60));

  check('全程无页面错误', errs.length === 0, errs.join('|') || 'none');

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log('=== 按需加载专项: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
