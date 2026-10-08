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

  await page.goto('https://gongyining0601.github.io/cet6-trainer/', { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.CET6_BANKS && window.CET6_BANKS.length >= 76, null, { timeout: 180000 });
  await page.waitForTimeout(1500);

  // 注入 3 天打卡 + 翻译条目
  await page.evaluate(() => {
    const C = window.CET6Core;
    const t = C.todayStr();
    const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null };
    st.history[C.addDays(t, -2)] = { minutes: 30, done: true, floor: false };
    st.history[C.addDays(t, -1)] = { minutes: 12, done: false, floor: true };
    st.history[t] = { minutes: 28, done: true, floor: false };
    st.plan = { date: t, v: C.PLAN_VERSION, items: [
      { key: 'essay-test', type: 'translation', qids: [], paperId: '2015-06-1', done: false, minutes: 0 }
    ] };
    localStorage.setItem('cet6_p1_state_v1', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.CET6_BANKS && window.CET6_BANKS.length >= 76, null, { timeout: 180000 });
  await page.waitForTimeout(2000);

  await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(600);
  const nums = await page.$$eval('#heatmap i', els => els.map(e => e.textContent).filter(t => t !== ''));
  console.log('[1] 热力图数字:', nums.slice(-3).join(','));

  await page.locator('nav button[data-p="today"]').click(); await page.waitForTimeout(500);
  await page.locator('#planList .card button').first().click(); await page.waitForTimeout(800);
  await page.locator('#essayTa').fill('The year 2011 was a historic moment in China urbanization. Over the next two decades, some 350 million rural people will move to cities.');
  await page.locator('#essayCheck').click(); await page.waitForTimeout(500);
  const box = await page.locator('#checkBox').textContent();
  console.log('[2] 踩分词自查:', (box.match(/覆盖 \d+\/\d+（\d+%）/) || ['(无)'])[0]);
  const prog = await page.locator('#quizProg').textContent();
  console.log('[3] 写译页卷号:', prog.trim());
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'online-p72.png') });
  console.log('[4] JS错误:', errors.length === 0 ? '无' : errors.slice(0, 3));
  await browser.close();
})();
