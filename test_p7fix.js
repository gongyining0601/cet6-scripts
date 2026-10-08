/* P7 修复回归：① 旧版(P6) plan 残留被丢弃重算 ② 错题重练题号有序(同卷相邻升序) */
const path = require('path');
const fs = require('fs');
const { chromium: loadChromium, EXE, ensurePaper } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const results = [];
  const check = (name, ok) => { results.push((ok ? 'ok' : 'FAIL') + ' - ' + name); };

  // ===== 场景1：旧版 P6 plan 残留（date=今天、无 v、含翻译卡与 2015 卷阅读）=====
  await page.goto('file://' + path.join(ROOT, 'app/index.html'));
  await page.waitForTimeout(600);
  // 按需加载（架构级）：首屏 CET6_BANKS 为空，下面要按 id 找卷，必须先注入该卷脚本
  await ensurePaper(page, '2015-06-1');
  const today = await page.evaluate(() => window.CET6Core ? window.CET6Core.todayStr() : '');
  const legacyState = await page.evaluate((d) => {
    const banks = window.CET6_BANKS;
    const lq = [];
    const p1 = banks.find(b => b.id === '2015-06-1');
    [20, 19, 23, 5].forEach(n => {
      const q = p1.questions.find(x => x.type === 'listening' && x.qno === n);
      if (q) lq.push(q.id);
    });
    const rIds = p1.questions.filter(q => q.type === 'reading' && q.qno >= 46 && q.qno <= 50).map(q => q.id);
    return {
      version: 1, history: {}, papers: {}, wrongbook: {}, essays: {},
      plan: { date: d, items: [
        { key: 'listening', type: 'listening', qids: lq, done: false, minutes: 0 },
        { key: 'reading', type: 'reading', qids: rIds, paperId: '2015-06-1', done: false, minutes: 0 },
        { key: 'translation', type: 'translation', qids: [], paperId: '2015-06-1', done: false, minutes: 0 }
      ] }
    };
  }, today);
  await page.evaluate((st) => {
    localStorage.setItem('cet6_user', '1001');
    localStorage.setItem('cet6_p1_state_v1_1001', JSON.stringify(st));
  }, legacyState);
  await page.reload(); await page.waitForTimeout(800);
  // reload 会重置 window.CET6_BANKS，下面场景2要按 id 找三套卷，需重新注入
  for (const pid of ['2015-06-1', '2016-06-1', '2015-12-1']) await ensurePaper(page, pid);

  const cardTexts = await page.$$eval('#planList .card', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  check('旧版 plan 被丢弃重算(' + cardTexts.length + ' 组)', cardTexts.length > 0 && !cardTexts.some(t => t.indexOf('翻译') >= 0));
  check('新题从最近考期 2026-06-3 开始', cardTexts.some(t => t.indexOf('2026-06-3') >= 0));
  const has2015 = cardTexts.some(t => t.indexOf('2015-06-1') >= 0);
  check('不再出现 2015-06-1 旧卷清单', !has2015);
  await page.screenshot({ path: path.join(ROOT, 'docs/ui-9-legacy-migrated.png'), fullPage: true });

  // ===== 场景2：错题重练顺序 =====
  // 注：三套卷的正文脚本已在上面（第 46-47 行 reload 之后）注入，此处不再重复注入。
  const wrongState = await page.evaluate(() => {
    const banks = window.CET6_BANKS;
    const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null };
    ['2015-06-1', '2016-06-1', '2015-12-1'].forEach(pid => {
      const p = banks.find(b => b.id === pid);
      if (!p) return;
      (p.questions || []).filter(q => q.type === 'listening').slice(0, 4).forEach((q, i) => {
        st.wrongbook[q.id] = { addedAt: '2026-09-20', box: 0, wrongCount: 2, ease: 2.0, iv: 1, streak: 0, due: '2026-09-2' + (i % 3) };
      });
    });
    return st;
  });
  await page.evaluate((st) => { localStorage.setItem('cet6_user', '1001'); localStorage.setItem('cet6_p1_state_v1_1001', JSON.stringify(st)); }, wrongState);
  await page.reload(); await page.waitForTimeout(900);
  await page.locator('nav button[data-p="wrong"]').click(); await page.waitForTimeout(500);
  const allBtn = page.locator('#wrongAllBtn');
  if (await allBtn.count()) {
    await allBtn.click(); await page.waitForTimeout(800);
    // 听力材料块的 DOM 已从 `div.linkline` 改为 `div.card`（内含 .listen-player 播放器），
    // 旧选择器 #quizBody .linkline 恒为空 → 「音频卡 N 个」必然假红。改为数"共用这一段录音"的材料块。
    const audioCards = await page.$$eval('#quizBody .card', els =>
      els.filter(e => /共用这一段录音/.test(e.textContent || '')).map(e => (e.textContent.match(/本组 (\d+) 题共用/) || [0, 0])[1]));
    check('同卷听力合并成材料块(音频卡 ' + audioCards.length + ' 个)', audioCards.length >= 1 && audioCards.length <= 3);
    await page.screenshot({ path: path.join(ROOT, 'docs/ui-10-wrong-order.png'), fullPage: true });
    const quizText = await page.locator('#quizBody').textContent();
    const order = (quizText.match(/Q(\d+)\./g) || []).map(x => Number(x.slice(1, -1)));
    check('重练页题号可提取(' + order.length + '题)', order.length >= 10);
    const segs = []; let cur = [order[0]];
    for (let i = 1; i < order.length; i++) {
      if (order[i] <= cur[cur.length - 1]) { segs.push(cur); cur = [order[i]]; } else cur.push(order[i]);
    }
    segs.push(cur);
    const allAsc = segs.every(seg => seg.every((v, i) => i === 0 || v > seg[i - 1]));
    check('各卷段内题号严格升序(' + segs.map(s => s.join(',')).join(' | ') + ')', allAsc);
  } else {
    check('错题本有到期重练按钮', false);
  }

  console.log(results.join('\n'));
  console.log('console errors:', errors.length ? errors.join(' | ') : 'none');
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== P7fix 回归: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
