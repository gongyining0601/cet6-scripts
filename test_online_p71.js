// 线上 P7.1 冒烟：注入 P6 旧 plan 验证迁移重算
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('https://gongyining0601.github.io/cet6-trainer/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(12000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);

  const today = await page.evaluate(() => CET6Core.todayStr());
  await page.evaluate((d) => {
    const banks = CET6_BANKS;
    const p1 = banks.find(b => b.id === '2015-06-1');
    const rIds = p1.questions.filter(q => q.type === 'reading' && q.qno >= 46 && q.qno <= 50).map(q => q.id);
    const lq = [20, 19, 23, 5].map(n => (p1.questions.find(x => x.type === 'listening' && x.qno === n) || {}).id).filter(Boolean);
    localStorage.setItem('cet6_p1_state_v1', JSON.stringify({
      version: 1, history: {}, papers: {}, wrongbook: {}, essays: {},
      plan: { date: d, items: [
        { key: 'listening', type: 'listening', qids: lq, done: false, minutes: 0 },
        { key: 'reading', type: 'reading', qids: rIds, paperId: '2015-06-1', done: false, minutes: 0 },
        { key: 'translation', type: 'translation', qids: [], paperId: '2015-06-1', done: false, minutes: 0 }
      ] }
    }));
  }, today);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);

  const cards = await page.$$eval('#planList .card', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('[1] 今日清单卡片:');
  cards.forEach(c => console.log('    ', c.slice(0, 60)));
  const hasEssay = cards.some(t => t.indexOf('翻译') >= 0 || t.indexOf('写作') >= 0);
  const has2026 = cards.some(t => t.indexOf('2026-06-3') >= 0);
  const has2015 = cards.some(t => t.indexOf('2015-06-1') >= 0);
  console.log('[2] 周五无写译:', !hasEssay, '| 从2026-06-3开始:', has2026, '| 无2015旧卷:', !has2015);
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'online-p71.png') });
  console.log('[3] JS错误:', errors.length === 0 ? '无' : errors.slice(0, 5));
  await browser.close();
})();
